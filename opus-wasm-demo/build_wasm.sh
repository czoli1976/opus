#!/usr/bin/env bash
# Builds Opus 1.6.1 + the WASM wrapper using Emscripten.
# Self-contained & cross-platform (Linux + macOS):
#   - downloads the official Opus 1.6.1 release tarball (SHA-256 pinned)
#   - builds static libopus with DRED / Deep PLC / OSCE enabled
#   - links the C wrapper into public/opus-wasm.{js,wasm}
set -euo pipefail

OPUS_VERSION="1.6.1"
OPUS_SHA256="6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1"
OPUS_TARBALL="opus-${OPUS_VERSION}.tar.gz"
OPUS_URL="https://ftp.osuosl.org/pub/xiph/releases/opus/${OPUS_TARBALL}"

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_CACHE="$DEMO_DIR/.opus-src"
OPUS_SRC="$SRC_CACHE/opus-${OPUS_VERSION}"
BUILD_DIR="$DEMO_DIR/wasm-build"
OUT_DIR="$DEMO_DIR/public"

mkdir -p "$SRC_CACHE" "$BUILD_DIR" "$OUT_DIR"

# ── 0. preflight: emscripten present? ───────────────────────────────────────
if ! command -v emcc >/dev/null 2>&1; then
    echo "ERROR: 'emcc' not found. Install & activate the Emscripten SDK first:" >&2
    echo "  git clone https://github.com/emscripten-core/emsdk.git" >&2
    echo "  cd emsdk && ./emsdk install latest && ./emsdk activate latest" >&2
    echo "  source ./emsdk_env.sh   # then re-run this script" >&2
    exit 1
fi

# portable parallel-job count (Linux: nproc, macOS: sysctl)
if command -v nproc >/dev/null 2>&1; then JOBS="$(nproc)";
elif command -v sysctl >/dev/null 2>&1; then JOBS="$(sysctl -n hw.ncpu)";
else JOBS=4; fi

# portable sha256 check (Linux: sha256sum, macOS: shasum -a 256)
verify_sha256() {
    local file="$1" expected="$2" actual
    if command -v sha256sum >/dev/null 2>&1; then
        actual="$(sha256sum "$file" | awk '{print $1}')"
    else
        actual="$(shasum -a 256 "$file" | awk '{print $1}')"
    fi
    if [ "$actual" != "$expected" ]; then
        echo "ERROR: SHA-256 mismatch for $file" >&2
        echo "  expected: $expected" >&2
        echo "  actual:   $actual"   >&2
        exit 1
    fi
}

# ── 1. fetch + verify + extract the Opus source ─────────────────────────────
if [ ! -d "$OPUS_SRC" ]; then
    echo "==> Downloading Opus ${OPUS_VERSION}..."
    if command -v curl >/dev/null 2>&1; then
        curl -fSL "$OPUS_URL" -o "$SRC_CACHE/$OPUS_TARBALL"
    else
        wget -q "$OPUS_URL" -O "$SRC_CACHE/$OPUS_TARBALL"
    fi
    echo "==> Verifying checksum..."
    verify_sha256 "$SRC_CACHE/$OPUS_TARBALL" "$OPUS_SHA256"
    echo "==> Extracting..."
    tar xzf "$SRC_CACHE/$OPUS_TARBALL" -C "$SRC_CACHE"
fi

# ── 2. build static libopus with emcmake ────────────────────────────────────
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

echo "==> Building libopus (-j${JOBS})..."
emmake make -j"${JOBS}" opus 2>&1

# ── 3. compile the wrapper and link everything ───────────────────────────────
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
