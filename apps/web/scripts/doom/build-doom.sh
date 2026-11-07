#!/bin/bash
# Builds doom-wasm inside the emscripten Docker image. No host toolchain needed.
# Usage: build-doom.sh <doom-wasm-src-dir>
set -euo pipefail
SRC="$(cd "$1" && pwd)"

# Modernize the emscripten flags (deprecated options error on current emsdk)
# and drop debug-only checks that cost a lot of CPU (SAFE_HEAP, stack checks, source maps).
python3 - "$SRC/configure.ac" <<'PY'
import os, re, sys
p = sys.argv[1]
s = open(p).read()
new = ('EMFLAGS="-s INVOKE_RUN=1 -s USE_SDL=2 -s USE_SDL_MIXER=2 -s USE_SDL_NET=2 '
       '-s WASM=1 -s ALLOW_MEMORY_GROWTH=0 -s FORCE_FILESYSTEM=1 '
       "-s EXPORTED_RUNTIME_METHODS=['FS','callMain'] "
       '-s EXIT_RUNTIME=1 -s INITIAL_MEMORY=64MB -s ERROR_ON_UNDEFINED_SYMBOLS=0 '
       '-s STACK_SIZE=5MB -s ASYNCIFY -s ASYNCIFY_STACK_SIZE=65536 -O3' + os.environ.get('EXTRA_EMFLAGS', '') + '"')
s = re.sub(r'^EMFLAGS=".*"$', new, s, flags=re.M)
open(p, "w").write(s)
PY
grep -n '^EMFLAGS' "$SRC/configure.ac"

docker run --rm -v "$SRC":/src -w /src emscripten/emsdk:latest bash -c '
  set -e
  apt-get update -qq >/dev/null && apt-get install -y -qq automake autoconf pkg-config >/dev/null
  emcc --version | head -1
  ./scripts/clean.sh || true
  emconfigure autoreconf -fiv >/dev/null
  ac_cv_exeext=".html" emconfigure ./configure --host=none-none-none >/dev/null
  emmake make -j8
'
ls -la "$SRC/src" | grep -E "websockets-doom|\.wasm"
