#!/usr/bin/env python3
"""Patches doom-wasm for embedding in t3code. Idempotent. Usage: patch-doom.py <doom-wasm-dir>"""
import sys
from pathlib import Path

root = Path(sys.argv[1])


def patch(rel, old, new):
    p = root / rel
    s = p.read_text()
    if new in s:
        return
    if old not in s:
        sys.exit(f"anchor not found in {rel}: {old[:60]!r}")
    p.write_text(s.replace(old, new, 1))


# No debug symbols: they only bloat the .wasm.
patch("configure.ac", 'CFLAGS="-O$OPT_LEVEL -g $WARNINGS', 'CFLAGS="-O$OPT_LEVEL $WARNINGS')

# Cap at Doom's native 35 Hz. SDL's vsync renderer switches the loop to
# requestAnimationFrame at display rate (120 Hz on ProMotion), so re-assert the
# timing on the first frame, after graphics init.
patch(
    "src/doom/d_main.c",
    "void D_RunFrame()\n{\n    int nowtime;",
    "void D_RunFrame()\n{\n    static boolean t3_timing_set = false;\n    int nowtime;",
)
patch(
    "src/doom/d_main.c",
    "    static boolean wipe;\n\n    if (wipe) {",
    "    static boolean wipe;\n\n"
    "    if (!t3_timing_set) {\n"
    "        t3_timing_set = true;\n"
    "        emscripten_set_main_loop_timing(EM_TIMING_SETTIMEOUT, 1000 / TICRATE);\n"
    "    }\n\n"
    "    if (wipe) {",
)

# Kill count for the host page's "agent finished" summary.
patch(
    "src/doom/g_game.c",
    "int consoleplayer;                       // player taking events and displaying",
    "int consoleplayer;                       // player taking events and displaying\n\n"
    "EMSCRIPTEN_KEEPALIVE int t3_kills(void) { return players[consoleplayer].killcount; }",
)
patch("src/doom/g_game.c", "#include <emscripten/websocket.h>\n", "#include <emscripten.h>\n#include <emscripten/websocket.h>\n")
# Pause by freezing Doom's clock and skipping frames. emscripten_pause_main_loop races
# ASYNCIFY sleeps (rewinding a sleep resumes the loop), which corrupts memory.
patch(
    "src/i_timer.c",
    "static Uint32 basetime = 0;\n",
    "static Uint32 basetime = 0;\n"
    "int t3_paused = 0;\n"
    "static Uint32 t3_paused_at = 0;\n"
    "static Uint32 t3_paused_total = 0;\n\n"
    "static Uint32 T3_Ticks(void)\n{\n"
    "    return (t3_paused ? t3_paused_at : SDL_GetTicks()) - t3_paused_total;\n}\n\n"
    "EMSCRIPTEN_KEEPALIVE void t3_set_paused(int paused)\n{\n"
    "    Uint32 now = SDL_GetTicks();\n"
    "    if (paused && !t3_paused) { t3_paused = 1; t3_paused_at = now; }\n"
    "    else if (!paused && t3_paused) { t3_paused = 0; t3_paused_total += now - t3_paused_at; }\n}\n",
)
timer = root / "src/i_timer.c"
timer.write_text(timer.read_text().replace("    ticks = SDL_GetTicks();\n", "    ticks = T3_Ticks();\n"))
patch(
    "src/doom/d_main.c",
    "    if (wipe) {\n        do {",
    "    if (t3_paused) return;\n\n    if (wipe) {\n        do {",
)
patch("src/doom/d_main.c", "void D_RunFrame()\n{", "extern int t3_paused;\n\nvoid D_RunFrame()\n{")
# Emscripten's callMain puts argv strings on the stack, and the first ASYNCIFY sleep unwinds that
# stack, so later reads of myargv (-warp, -config) see reused memory. Copy argv to the heap.
patch(
    "src/i_main.c",
    "    myargc = argc;\n    myargv = argv;\n",
    "    myargc = argc;\n"
    "    myargv = malloc(sizeof(char *) * (argc + 1));\n"
    "    for (int i = 0; i < argc; i++) myargv[i] = strdup(argv[i]);\n"
    "    myargv[argc] = NULL;\n",
)
patch("src/i_main.c", "#include <stdlib.h>\n", "#include <stdlib.h>\n#include <string.h>\n")
# emscripten/html5.h now includes <stdbool.h>, so files that include it got a 1-byte bool
# `boolean` while the rest got a 4-byte enum; shared globals and structs disagreed on layout.
# Use int everywhere: same size as the enum, and keeps Doom's -1 "unset" state (r_things.c).
doomtype = root / "src/doomtype.h"
dt = doomtype.read_text()
block = dt[dt.index("#if defined(__cplusplus) || defined(__bool_true_false_are_defined)"):]
block = block[: block.index("#endif") + len("#endif")]
if "typedef int boolean;" not in dt:
    doomtype.write_text(dt.replace(block, "#include <stdbool.h>\n\ntypedef int boolean;"))
# Quick save for the host page: it saves when the game hides and boots with -loadgame 0 on
# "Continue", so a reload (or Safari without moveBefore) resumes instead of restarting.
# Freedoom levels outgrow vanilla's savegame size cap, which would otherwise I_Error.
patch(
    "src/doom/g_game.c",
    "void G_DoSaveGame(void)\n{",
    "extern int scaledviewwidth;\nextern boolean setsizeneeded;\n\n"
    "EMSCRIPTEN_KEEPALIVE int t3_save(void)\n{\n"
    "    // Saving redraws the view border, which needs the view size from the first rendered frame.\n"
    "    if (gamestate != GS_LEVEL || demoplayback || !usergame) return 0;\n"
    "    if (setsizeneeded || scaledviewwidth == 0) return 0;\n"
    "    vanilla_savegame_limit = 0;\n"
    "    savegameslot = 0;\n"
    "    M_StringCopy(savedescription, \"T3CODE\", sizeof(savedescription));\n"
    "    G_DoSaveGame();\n"
    "    return 1;\n}\n\n"
    "void G_DoSaveGame(void)\n{",
)
print("patched")
