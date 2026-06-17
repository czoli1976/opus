#!/usr/bin/env bash
# Builds Opus + the WASM wrapper using Emscripten.
# Outputs: public/opus-wasm.js  public/opus-wasm.wasm
set -euo pipefail

OPUS_SRC="/tmp/opus-1.6.1"
DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$DEMO_DIR/wasm-build"
OUT_DIR="$DEMO_DIR/public"

mkdir -p "$BUILD_DIR" "$OUT_DIR"

# ── 1. build static libopus with emcmake ────────────────────────────────────
echo "==> Configuring Opus with emcmake..."
cd "$BUILD_DIR"
emcmake cmake "$OPUS_SRC" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DOPUS_BUILD_PROGRAMS=OFF \
    -DOPUS_BUILD_TESTING=OFF \
    -DOPUS_ENABLE_FLOAT_APPROX=OFF \
    -DOPUS_DEEP_PLC=ON \
    -DOPUS_DRED=ON \
    -DOPUS_OSCE=ON \
    -DOPUS_DISABLE_INTRINSICS=ON \
    -DOPUS_STACK_PROTECTOR=OFF \
    -DOPUS_FORTIFY_SOURCE=OFF 2>&1

echo "==> Building libopus..."
emmake make -j"$(nproc)" opus 2>&1

# ── 2. compile the wrapper and link everything ───────────────────────────────
echo "==> Compiling WASM module..."
cd "$DEMO_DIR"
emcc \
    src/opus_wasm_wrapper.c \
    "$BUILD_DIR/libopus.a" \
    -I"$OPUS_SRC/include" \
    -O3 \
    -s WASM=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=33554432 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="createOpusModule" \
    -s EXPORTED_RUNTIME_METHODS='["cwrap","ccall","getValue","setValue","HEAPF32","HEAPU8","HEAP32"]' \
    -s EXPORTED_FUNCTIONS='[
        "_malloc","_free",
        "_opus_wasm_malloc","_opus_wasm_free",
        "_opus_wasm_encoder_create",
        "_opus_wasm_encoder_destroy",
        "_opus_wasm_encoder_set_bitrate",
        "_opus_wasm_encoder_set_complexity",
        "_opus_wasm_encoder_set_inband_fec",
        "_opus_wasm_encoder_set_packet_loss_perc",
        "_opus_wasm_encoder_set_dred_duration",
        "_opus_wasm_encoder_get_dred_duration",
        "_opus_wasm_encode_float",
        "_opus_wasm_decoder_create",
        "_opus_wasm_decoder_destroy",
        "_opus_wasm_dred_available",
        "_opus_wasm_decode_float",
        "_opus_wasm_decode_lost",
        "_opus_wasm_get_bandwidth_str"
    ]' \
    -s NO_EXIT_RUNTIME=1 \
    -s ENVIRONMENT='web,worker' \
    -o "$OUT_DIR/opus-wasm.js"

echo "==> Done!  ->  $OUT_DIR/opus-wasm.js  +  $OUT_DIR/opus-wasm.wasm"
