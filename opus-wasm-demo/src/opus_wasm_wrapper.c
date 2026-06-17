/**
 * Opus WASM wrapper - exposes Opus encoder/decoder + DRED API to JavaScript.
 *
 * Compiled with Emscripten. All heap memory is managed by the caller via
 * the helpers below; the JS side uses the same HEAPF32 / HEAPU8 views.
 */

#include <stdlib.h>
#include <string.h>
#include "opus.h"

/* ── memory helpers ── */
void *opus_wasm_malloc(int size) { return malloc(size); }
void  opus_wasm_free(void *ptr)  { free(ptr); }

/* ─────────────────────────────────────────────────
 * Encoder
 * ───────────────────────────────────────────────── */

typedef struct {
    OpusEncoder *enc;
    int          sample_rate;
    int          channels;
} WasmEncoder;

WasmEncoder *opus_wasm_encoder_create(int sample_rate, int channels,
                                      int application, int *error)
{
    WasmEncoder *w = (WasmEncoder *)malloc(sizeof(WasmEncoder));
    if (!w) { if (error) *error = OPUS_ALLOC_FAIL; return NULL; }

    w->enc = opus_encoder_create(sample_rate, channels, application, error);
    if (!w->enc) { free(w); return NULL; }

    w->sample_rate = sample_rate;
    w->channels    = channels;
    return w;
}

void opus_wasm_encoder_destroy(WasmEncoder *w)
{
    if (w) { opus_encoder_destroy(w->enc); free(w); }
}

int opus_wasm_encoder_set_bitrate(WasmEncoder *w, int bitrate)
{
    return opus_encoder_ctl(w->enc, OPUS_SET_BITRATE(bitrate));
}

int opus_wasm_encoder_set_complexity(WasmEncoder *w, int complexity)
{
    return opus_encoder_ctl(w->enc, OPUS_SET_COMPLEXITY(complexity));
}

int opus_wasm_encoder_set_inband_fec(WasmEncoder *w, int enable)
{
    return opus_encoder_ctl(w->enc, OPUS_SET_INBAND_FEC(enable));
}

int opus_wasm_encoder_set_packet_loss_perc(WasmEncoder *w, int loss_perc)
{
    return opus_encoder_ctl(w->enc, OPUS_SET_PACKET_LOSS_PERC(loss_perc));
}

/** Enable/disable DRED and set redundancy duration in samples (max 240 ms). */
int opus_wasm_encoder_set_dred_duration(WasmEncoder *w, int duration_samples)
{
    return opus_encoder_ctl(w->enc, OPUS_SET_DRED_DURATION(duration_samples));
}

int opus_wasm_encoder_get_dred_duration(WasmEncoder *w, int *out)
{
    return opus_encoder_ctl(w->enc, OPUS_GET_DRED_DURATION(out));
}

/**
 * Encode one frame of float PCM.
 *
 * @param pcm_ptr  Pointer into HEAPF32 (interleaved, [-1,1]).
 * @param frame_sz Samples per channel.
 * @param out_ptr  Pointer into HEAPU8 for the encoded packet.
 * @param max_len  Capacity of out_ptr in bytes.
 * @returns Byte count of the encoded packet, or a negative error code.
 */
int opus_wasm_encode_float(WasmEncoder *w,
                           float *pcm_ptr, int frame_sz,
                           unsigned char *out_ptr, int max_len)
{
    return opus_encode_float(w->enc, pcm_ptr, frame_sz, out_ptr, max_len);
}

/* ─────────────────────────────────────────────────
 * Decoder
 * ───────────────────────────────────────────────── */

typedef struct {
    OpusDecoder     *dec;
    OpusDREDDecoder *dred_dec;
    OpusDRED        *dred;
    int              sample_rate;
    int              channels;
} WasmDecoder;

WasmDecoder *opus_wasm_decoder_create(int sample_rate, int channels, int *error)
{
    WasmDecoder *w = (WasmDecoder *)calloc(1, sizeof(WasmDecoder));
    if (!w) { if (error) *error = OPUS_ALLOC_FAIL; return NULL; }

    w->dec = opus_decoder_create(sample_rate, channels, error);
    if (!w->dec) { free(w); return NULL; }

    w->sample_rate = sample_rate;
    w->channels    = channels;

    /* DRED components (optional – may return NULL if DRED not compiled in) */
    int dred_err = OPUS_OK;
    w->dred_dec = opus_dred_decoder_create(&dred_err);
    if (w->dred_dec) {
        int dred_state_err = OPUS_OK;
        w->dred = opus_dred_alloc(&dred_state_err);
        if (!w->dred) {
            opus_dred_decoder_destroy(w->dred_dec);
            w->dred_dec = NULL;
        }
    }

    return w;
}

void opus_wasm_decoder_destroy(WasmDecoder *w)
{
    if (!w) return;
    if (w->dred)     opus_dred_free(w->dred);
    if (w->dred_dec) opus_dred_decoder_destroy(w->dred_dec);
    opus_decoder_destroy(w->dec);
    free(w);
}

int opus_wasm_dred_available(WasmDecoder *w)
{
    return (w && w->dred_dec && w->dred) ? 1 : 0;
}

/**
 * Normal decode – use when the packet was received.
 * Returns samples per channel, or negative on error.
 */
int opus_wasm_decode_float(WasmDecoder *w,
                           unsigned char *data, int data_len,
                           float *pcm_out, int frame_sz)
{
    return opus_decode_float(w->dec, data, data_len, pcm_out, frame_sz, 0);
}

/**
 * FEC/PLC decode – use when a packet was LOST.
 *
 * If DRED data was parsed from the *previous* packet it will be used
 * automatically by the decoder (deep-PLC / DRED recovery).
 *
 * @param next_data  The *next* available packet (may be NULL for pure PLC).
 * @param next_len   Length of next_data (0 if NULL).
 * @param max_dred   Maximum DRED samples to extract from next_data.
 */
int opus_wasm_decode_lost(WasmDecoder *w,
                          unsigned char *next_data, int next_len,
                          int max_dred,
                          float *pcm_out, int frame_sz)
{
    if (w->dred_dec && w->dred && next_data && next_len > 0 && max_dred > 0) {
        int dred_end = 0;
        /* Parse DRED from the next packet */
        int parsed = opus_dred_parse(w->dred_dec, w->dred,
                                     next_data, next_len,
                                     max_dred, w->sample_rate,
                                     &dred_end, 0 /*defer_processing*/);
        if (parsed > 0) {
            /* Decode the lost frame using DRED data */
            int ret = opus_decoder_dred_decode_float(w->dec, w->dred,
                                                0 /*dred_offset*/,
                                                pcm_out, frame_sz);
            if (ret >= 0) return ret;
            /* Fall through to standard FEC if DRED fails */
        }
    }

    /* Standard FEC (inband) or PLC */
    int use_fec = (next_data && next_len > 0) ? 1 : 0;
    return opus_decode_float(w->dec, next_data, next_len,
                             pcm_out, frame_sz, use_fec);
}

/**
 * Get the last packet's bandwidth as a string (for display).
 */
const char *opus_wasm_get_bandwidth_str(WasmDecoder *w)
{
    opus_int32 bw = 0;
    opus_decoder_ctl(w->dec, OPUS_GET_BANDWIDTH(&bw));
    switch (bw) {
        case OPUS_BANDWIDTH_NARROWBAND:    return "NB (4 kHz)";
        case OPUS_BANDWIDTH_MEDIUMBAND:    return "MB (6 kHz)";
        case OPUS_BANDWIDTH_WIDEBAND:      return "WB (8 kHz)";
        case OPUS_BANDWIDTH_SUPERWIDEBAND: return "SWB (12 kHz)";
        case OPUS_BANDWIDTH_FULLBAND:      return "FB (20 kHz)";
        default:                           return "auto";
    }
}
