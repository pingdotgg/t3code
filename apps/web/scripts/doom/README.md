# Inline Doom build

`apps/web/public/doom/` holds a compiled Chocolate Doom (GPL-2.0, see `DOOM-COPYING.md`) and the
Freedoom Phase 1 IWAD (BSD-3-Clause, see `FREEDOOM-COPYING.txt`). This folder is the
corresponding source recipe for the compiled files.

Source: https://github.com/cloudflare/doom-wasm at `65e0d3ae2ffa604155eebd96ed40da6567bd08f4`.

Rebuild (needs Docker only):

```sh
git clone https://github.com/cloudflare/doom-wasm.git /path/to/doom-wasm
git -C /path/to/doom-wasm checkout 65e0d3ae2ffa604155eebd96ed40da6567bd08f4
python3 apps/web/scripts/doom/patch-doom.py /path/to/doom-wasm
apps/web/scripts/doom/build-doom.sh /path/to/doom-wasm
cp /path/to/doom-wasm/src/websockets-doom.{js,wasm} apps/web/public/doom/
```

What the patches change, and why:

- `boolean` is `int` in every file. Current Emscripten's `html5.h` pulls in `<stdbool.h>`, which
  split Doom into 1-byte and 4-byte booleans and corrupted shared state.
- `argv` is copied to the heap. Emscripten puts it on a stack that the first async sleep reuses.
- Pause freezes Doom's clock and skips frames (`t3_set_paused`), instead of pausing
  Emscripten's main loop, which races its async sleeps.
- Frames run at Doom's native 35 Hz, not the display's refresh rate.
- 5 MB stack (Emscripten now defaults to 64 KB), no debug symbols, `t3_kills` export.
