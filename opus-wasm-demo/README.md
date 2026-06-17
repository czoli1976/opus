# Opus 1.6.1 WASM + Vonage Video API Demo

Runs **Opus 1.6.1 as WebAssembly** (with the neural features Chrome's built‑in
Opus lacks — **DRED**, **Deep PLC**, **OSCE**) and publishes the WASM‑encoded
audio through the **Vonage Video API** JS SDK.

```
Microphone ─▶ AudioWorklet ─▶ WASM Opus 1.6.1 encode ─▶ (loss sim) ─▶ WASM Opus decode
                                                                            │
                                          MediaStreamTrack ◀── decoded PCM ─┘
                                                  │
                               OT.initPublisher({ audioSource: track })  ─▶ Vonage
```

## Prerequisites

| To… | You need |
|---|---|
| **Just run it** (WASM is committed) | Node.js ≥ 18 |
| **Rebuild the WASM** | Node.js ≥ 18, CMake ≥ 3.13, and the Emscripten SDK (`emcc`) |

> The compiled `public/opus-wasm.{js,wasm}` is checked in, so you can run the
> demo without installing Emscripten. You only need a rebuild if you change
> `src/opus_wasm_wrapper.c`.

## Run (no build needed)

```bash
cd opus-wasm-demo
node server.js          # → http://localhost:3000
```

Open **http://localhost:3000**, enter your Vonage **API Key / Session ID /
Token** (generate the session + token on your own server), and click
**Connect & Publish**. `http://localhost` is a secure context, so mic access
works; any non‑localhost deployment must be served over **https**.

## Rebuild the WASM (optional)

`build_wasm.sh` is self‑contained: it downloads the official Opus 1.6.1 release
tarball (SHA‑256 pinned), verifies it, and builds with DRED + Deep PLC + OSCE
enabled. Works on Linux and macOS.

```bash
# 1. install + activate Emscripten (once)
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest
source ./emsdk_env.sh
cd -

# 2. build
cd opus-wasm-demo
bash build_wasm.sh      # → public/opus-wasm.js + public/opus-wasm.wasm
```

On macOS you also need CMake (`brew install cmake`) and the Xcode command‑line
tools (`xcode-select --install`).

## Controls & what they exercise

| Control | Effect |
|---|---|
| **Bitrate** | `OPUS_SET_BITRATE` on the WASM encoder |
| **Frame size** | encoder frame duration (restart session to apply) |
| **Loss simulation** | drops N % of packets before decode, in the worklet |
| **DRED duration** | `OPUS_SET_DRED_DURATION` (0–240 ms of deep redundancy) |
| **Enable DRED** | toggles DRED on the encoder |
| **Enable Inband FEC** | classic LBRR FEC + packet‑loss‑percent hint |
| **Mute Vonage mic** | publish only the WASM track, not the raw mic |

Raise **Loss simulation** and watch **DRED recoveries** climb in the stats
panel — that's the 1.5/1.6 neural redundancy reconstructing the dropped frames.

## Files

| Path | Purpose |
|---|---|
| `src/opus_wasm_wrapper.c` | C API over libopus encoder/decoder **+ DRED** |
| `build_wasm.sh` | Emscripten build (download → verify → compile → link) |
| `public/opus-wasm.{js,wasm}` | Prebuilt WASM module (DNN weights included) |
| `public/worklet/opus-processor.js` | AudioWorklet: WASM encode+decode + loss sim |
| `public/index.html` | Demo UI + Vonage session wiring |
| `server.js` | Dev server with the COOP/COEP headers WASM needs |

## Notes

- The build disables x86 intrinsics, the stack protector, and FORTIFY — none of
  which link cleanly under `wasm-ld` — and enables `OPUS_DRED`, `OPUS_DEEP_PLC`,
  `OPUS_OSCE`.
- The `.wasm` is ~3.8 MB because the DRED/Deep‑PLC/OSCE neural weights are baked
  in. A build without those features (e.g. stock `openclaw/libopus-wasm`) is far
  smaller but cannot do DRED.
