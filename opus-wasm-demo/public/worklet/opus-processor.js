/**
 * AudioWorkletProcessor that runs Opus 1.6.1 (WASM) for encode+decode,
 * simulating configurable packet loss so DRED recovery can be observed.
 *
 * Message protocol (from main thread via port.postMessage):
 *   { cmd: 'init', wasmUrl, sampleRate, frameMs, bitrate, dredDurationMs, fecEnabled, lossPercent }
 *   { cmd: 'setLoss',        lossPercent }    // 0-100
 *   { cmd: 'setDred',        durationMs  }    // 0 = disabled
 *   { cmd: 'setFec',         enabled     }
 *   { cmd: 'setBitrate',     bps         }
 *
 * Messages back to main thread:
 *   { type: 'ready' }
 *   { type: 'stats', packetsEncoded, packetsLost, dredRecoveries, bytesPerPacket, bandwidthStr }
 *   { type: 'error', message }
 */

const SAMPLE_RATE = 48000;
const CHANNELS    = 1;
const MAX_PACKET  = 4000; /* bytes */

/* ── simple LCG for deterministic loss simulation ── */
let lcgState = 12345;
function lcgRand() {
    lcgState = (Math.imul(1664525, lcgState) + 1013904223) >>> 0;
    return lcgState / 0xFFFFFFFF;
}

class OpusProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._ready       = false;
        this._module      = null;
        this._encoder     = null;
        this._decoder     = null;
        this._pcmBuf      = null;    /* WASM heap ptr for float PCM input */
        this._outBuf      = null;    /* WASM heap ptr for encoded bytes */
        this._decBuf      = null;    /* WASM heap ptr for decoded PCM */
        this._pcmBufLen   = 0;
        this._frameSize   = 0;       /* samples per channel */
        this._inputRing   = [];      /* accumulate 128-sample WebAudio blocks */
        this._lossPercent = 0;
        this._dredEnabled = false;
        this._dredAvailable = false;

        /* stats */
        this._packetsEncoded  = 0;
        this._packetsLost     = 0;
        this._dredRecoveries  = 0;
        this._lastBytes       = 0;
        this._statTimer       = 0;

        /* lookahead: hold onto previous+current packets for DRED decode */
        this._prevPacket  = null;
        this._prevLen     = 0;
        this._curPacket   = null;
        this._curLen      = 0;

        this.port.onmessage = (e) => this._onMessage(e.data);
    }

    async _onMessage(msg) {
        switch (msg.cmd) {
            case 'init':    await this._init(msg); break;
            case 'setLoss': this._lossPercent = Math.max(0, Math.min(100, msg.lossPercent)); break;
            case 'setDred': this._setDred(msg.durationMs); break;
            case 'setFec':  this._setFec(msg.enabled); break;
            case 'setBitrate': if (this._module && this._encoder)
                this._module._opus_wasm_encoder_set_bitrate(this._encoder, msg.bps); break;
        }
    }

    async _init(cfg) {
        try {
            /* Load the WASM module (importScripts doesn't work in worklets; use fetch+eval trick) */
            const resp = await fetch(cfg.wasmUrl.replace('opus-wasm.wasm', 'opus-wasm.js'));
            const js   = await resp.text();
            /* eslint-disable-next-line no-new-func */
            const factory = new Function('module', js + '\nreturn createOpusModule(module);');
            this._module = await factory({
                locateFile: (f) => cfg.wasmUrl.replace('opus-wasm.js', f)
            });

            const M = this._module;
            this._frameSize  = Math.floor(SAMPLE_RATE * (cfg.frameMs || 20) / 1000);
            const pcmBytes   = this._frameSize * CHANNELS * 4; /* float32 */

            /* allocate WASM heap buffers */
            this._pcmBuf  = M._malloc(pcmBytes);
            this._pcmBufLen = this._frameSize * CHANNELS;
            this._outBuf  = M._malloc(MAX_PACKET);
            this._decBuf  = M._malloc(pcmBytes);

            /* encoder */
            const encErrPtr = M._malloc(4);
            this._encoder = M._opus_wasm_encoder_create(
                SAMPLE_RATE, CHANNELS, 2048 /* OPUS_APPLICATION_VOIP */, encErrPtr);
            const encErr = M.getValue(encErrPtr, 'i32');
            M._free(encErrPtr);
            if (!this._encoder || encErr < 0)
                throw new Error(`Encoder create failed: ${encErr}`);

            M._opus_wasm_encoder_set_bitrate(this._encoder, cfg.bitrate || 32000);
            M._opus_wasm_encoder_set_complexity(this._encoder, 9);

            /* decoder */
            const decErrPtr = M._malloc(4);
            this._decoder = M._opus_wasm_decoder_create(
                SAMPLE_RATE, CHANNELS, decErrPtr);
            const decErr = M.getValue(decErrPtr, 'i32');
            M._free(decErrPtr);
            if (!this._decoder || decErr < 0)
                throw new Error(`Decoder create failed: ${decErr}`);

            this._dredAvailable = !!M._opus_wasm_dred_available(this._decoder);

            /* apply initial settings */
            if (cfg.dredDurationMs > 0)   this._setDred(cfg.dredDurationMs);
            if (cfg.fecEnabled)            this._setFec(true);

            this._ready = true;
            this.port.postMessage({ type: 'ready', dredAvailable: this._dredAvailable });
        } catch(err) {
            this.port.postMessage({ type: 'error', message: err.message });
        }
    }

    _setDred(durationMs) {
        if (!this._module || !this._encoder) return;
        const samples = Math.floor(SAMPLE_RATE * Math.max(0, durationMs) / 1000);
        this._module._opus_wasm_encoder_set_dred_duration(this._encoder, samples);
        this._dredEnabled = samples > 0;
    }

    _setFec(enabled) {
        if (!this._module || !this._encoder) return;
        this._module._opus_wasm_encoder_set_inband_fec(this._encoder, enabled ? 1 : 0);
        if (enabled)
            this._module._opus_wasm_encoder_set_packet_loss_perc(this._encoder, 20);
    }

    process(inputs, outputs) {
        if (!this._ready) return true;

        /* collect microphone samples */
        const input = inputs[0]?.[0];
        if (input) this._inputRing.push(...input);

        /* process complete frames */
        while (this._inputRing.length >= this._frameSize) {
            const frame = this._inputRing.splice(0, this._frameSize);
            this._processFrame(frame, outputs[0]?.[0]);
        }

        /* send stats ~4× per second */
        this._statTimer++;
        if (this._statTimer >= 12) { /* 128 samples @ 48kHz ≈ 2.67ms per block; 12 ≈ 32ms */
            this._statTimer = 0;
            this._sendStats();
        }

        return true;
    }

    _processFrame(pcmArray, outChannel) {
        const M          = this._module;
        const HEAPF32    = M.HEAPF32;
        const frameSize  = this._frameSize;

        /* write PCM into WASM heap */
        const pcmOffset = this._pcmBuf >> 2;
        for (let i = 0; i < frameSize; i++) HEAPF32[pcmOffset + i] = pcmArray[i];

        /* ENCODE */
        const encoded = M._opus_wasm_encode_float(
            this._encoder, this._pcmBuf, frameSize, this._outBuf, MAX_PACKET);
        if (encoded < 0) return;

        this._packetsEncoded++;

        /* copy encoded bytes out of WASM heap */
        const packet = new Uint8Array(encoded);
        const heapU8 = M.HEAPU8;
        for (let i = 0; i < encoded; i++) packet[i] = heapU8[this._outBuf + i];

        /* LOSS SIMULATION */
        const lost = lcgRand() * 100 < this._lossPercent;

        let decoded = 0;

        if (!lost) {
            /* normal decode */
            decoded = M._opus_wasm_decode_float(
                this._decoder, this._outBuf, encoded, this._decBuf, frameSize);

            /* update sliding window */
            this._prevPacket = this._curPacket;
            this._prevLen    = this._curLen;
            this._curPacket  = packet;
            this._curLen     = encoded;
            this._lastBytes  = encoded;
        } else {
            this._packetsLost++;

            /* write the NEXT packet (current) into WASM heap for DRED/FEC */
            const nextBuf = M._malloc(encoded);
            for (let i = 0; i < encoded; i++) heapU8[nextBuf + i] = packet[i];

            const maxDred = this._dredEnabled
                ? Math.floor(SAMPLE_RATE * 0.240) /* up to 240 ms */
                : 0;

            decoded = M._opus_wasm_decode_lost(
                this._decoder,
                nextBuf, encoded,
                maxDred,
                this._decBuf, frameSize);

            M._free(nextBuf);

            if (this._dredEnabled && decoded > 0) this._dredRecoveries++;
        }

        /* write decoded PCM to AudioWorklet output */
        if (outChannel && decoded > 0) {
            const decOffset = this._decBuf >> 2;
            const n = Math.min(decoded, outChannel.length);
            for (let i = 0; i < n; i++) outChannel[i] = HEAPF32[decOffset + i];
            /* zero-fill the rest */
            for (let i = n; i < outChannel.length; i++) outChannel[i] = 0;
        }
    }

    _sendStats() {
        if (!this._module || !this._decoder) return;
        const bwPtr = this._module._opus_wasm_get_bandwidth_str(this._decoder);
        /* read C string from WASM memory */
        let bwStr = '';
        const heap = this._module.HEAPU8;
        let p = bwPtr;
        while (heap[p]) bwStr += String.fromCharCode(heap[p++]);

        this.port.postMessage({
            type: 'stats',
            packetsEncoded:  this._packetsEncoded,
            packetsLost:     this._packetsLost,
            dredRecoveries:  this._dredRecoveries,
            bytesPerPacket:  this._lastBytes,
            bandwidthStr:    bwStr,
            dredEnabled:     this._dredEnabled,
            dredAvailable:   this._dredAvailable,
        });
    }
}

registerProcessor('opus-processor', OpusProcessor);
