import re
import pathlib

BASE = pathlib.Path("/home/ben/audits/t3code-v0.1.7/apps/web/src/terminal/ghostty")
src = (BASE / "surface.ts").read_text().split("\n")
rewritten = (BASE / "surface.rewritten.tmp.ts").read_text().split("\n")


def L(a, b):
    return src[a - 1 : b]


def dedent2(lines):
    return [l[2:] if l.startswith("  ") else l for l in lines]


def exportify(text):
    return re.sub(
        r"^(async function|function|interface|type|const|let) (\w+)",
        r"export \1 \2",
        text,
        flags=re.M,
    )


FONT_CONSTS = """const DEFAULT_TERMINAL_FONT_SIZE = 12;
const MIN_TERMINAL_FONT_SIZE = 6;
const MAX_TERMINAL_FONT_SIZE = 32;
const TERMINAL_GLYPH_FALLBACKS =
  '"Symbols Nerd Font Mono", "Symbols Nerd Font", "JetBrainsMono Nerd Font", ' +
  '"JetBrainsMono NF", "FiraCode Nerd Font", "Hack Nerd Font", "MesloLGS NF", ' +
  '"CaskaydiaCove Nerd Font", "PowerlineSymbols", monospace';
// The platform's own monospace faces; concrete names only, because an
// unknown keyword (like ui-monospace) makes canvas font shorthand parsing
// reject the whole string.
const DEFAULT_TERMINAL_FONT_FAMILY =
  '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", ' + TERMINAL_GLYPH_FALLBACKS;
const TERMINAL_FONT_LOAD_TEXT = "iMW0@# .";
const TERMINAL_FONT_LOAD_VARIANTS = [
  "normal 400",
  "normal 700",
  "italic 400",
  "italic 700",
] as const;"""

fonts = "\n".join(
    [
        'import { isMonospaceFamily } from "../../appearanceFonts";',
        'import symbolsFontUrl from "./fonts/SymbolsNerdFontMono-Regular.woff2?url";',
        "",
        FONT_CONSTS,
        "",
        *L(49, 130),
    ]
)
(BASE / "surfaceFonts.ts").write_text(exportify(fonts) + "\n")

GEOMETRY_CONSTS = """export const CONTENT_PADDING = 4;
const MIN_SCROLLBAR_THUMB_HEIGHT = 18;"""

geometry = "\n".join(
    [
        'import { SELECTION_MULTI_CLICK_INTERVAL_MS } from "../../lib/selectionActions";',
        'import {',
        "  GHOSTTY_CELL_WIDE,",
        "  type GhosttyCell,",
        "  type GhosttyScrollbar,",
        "  type GhosttySnapshot,",
        '} from "./core";',
        'import type { GhosttyCellMetrics, GhosttyCellRange } from "./renderer";',
        "",
        GEOMETRY_CONSTS,
        "",
        *L(132, 252),
        "",
        *L(426, 450),
    ]
)
(BASE / "surfaceGeometry.ts").write_text(exportify(geometry) + "\n")

inputmod = "\n".join(
    [
        'import { isMacPlatform } from "../../lib/utils";',
        "",
        *L(254, 424),
    ]
)
(BASE / "surfaceInput.ts").write_text(exportify(inputmod) + "\n")

# ------- assemble surface.ts -------
class_lines = rewritten[471:]  # from "export class ..." line (index 471 == line 472)
class_text = "\n".join(class_lines)
class_text = class_text.replace('export * from "./surfaceParts";', "").rstrip()
# publicize members (parts modules read/write them); keep the private constructor.
class_text = re.sub(r"^  private (?!constructor)", "  ", class_text, flags=re.M)

handler_modules = [
    "surfaceKeyboard",
    "surfacePointer",
    "surfaceScrollbar",
    "surfaceRender",
    "surfaceMouse",
    "surfaceSelection",
    "surfaceEvents",
]

all_exports = {}
for mod in [*handler_modules, "surfaceFonts", "surfaceGeometry", "surfaceInput"]:
    text = (BASE / f"{mod}.ts").read_text()
    names = re.findall(
        r"^export (?:async function|function|const|interface|type|class) (\w+)", text, re.M
    )
    all_exports[mod] = names

prelude = "\n".join(L(452, 470))
body = "\n".join([prelude, "", class_text])

def used(name, text):
    return re.search(rf"\b{name}\b", text) is not None

def imports_for(text, modules):
    lines = []
    for mod in modules:
        names = [n for n in all_exports[mod] if used(n, text)]
        if not names:
            continue
        lines.append("import {")
        for n in sorted(names):
            lines.append(f"  {n},")
        lines.append(f'}} from "./{mod}";')
    return lines

# core/renderer imports still needed by surface.ts
header = [
    'import {',
    '  GHOSTTY_CELL_WIDE,',
    '  GhosttyTerminalCore,',
    '  type GhosttyCell,',
    '  type GhosttyScrollbar,',
    '  type GhosttySnapshot,',
    '  type GhosttyTheme,',
    '} from "./core";',
    'import {',
    '  measureGhosttyCell,',
    '  renderGhosttySnapshot,',
    '  terminalGridSize,',
    '  type GhosttyCellRange,',
    '  type GhosttyCellMetrics,',
    '} from "./renderer";',
    'import { observeResize } from "../../lib/observeResize";',
    'import { terminalLinkAtPositionWithRange } from "./surfaceParts";',
]
header += imports_for(body, ["surfaceFonts", "surfaceGeometry", "surfaceInput", *handler_modules])

exports = "\n".join(
    f'export * from "./{m}";'
    for m in ["surfaceFonts", "surfaceGeometry", "surfaceInput", "surfaceParts", *handler_modules]
)
surface = "\n".join(header) + "\n\n" + body + "\n\n" + exports + "\n"
(BASE / "surface.assembled.tmp.ts").write_text(surface)

EXTRA_IMPORTS = {
    "surfaceKeyboard": ['import { isMacPlatform } from "../../lib/utils";'],
    "surfaceMouse": ['import { terminalLinkAtPositionWithRange } from "./surfaceParts";'],
    "surfaceRender": ['import { renderGhosttySnapshot } from "./renderer";'],
}

EXTRA_DECLS = {
    "surfaceRender": """const CURSOR_BLINK_INTERVAL_MS = 500;
/** End an unterminated synchronized update instead of freezing the last frame. */
const SYNCHRONIZED_OUTPUT_RENDER_TIMEOUT_MS = 500;""",
}

# ------- handler module imports -------
for mod in handler_modules:
    path = BASE / f"{mod}.ts"
    text = path.read_text()
    body_text = text
    imp = [
        'import type { GhosttyTerminalSurface } from "./surface";',
    ]
    imp += EXTRA_IMPORTS.get(mod, [])
    imp += imports_for(body_text, ["surfaceFonts", "surfaceGeometry", "surfaceInput"])
    # other handler modules (cross-module calls)
    for other in handler_modules:
        if other == mod:
            continue
        names = [n for n in all_exports[other] if used(n, body_text)]
        if names:
            imp.append("import {")
            for n in sorted(names):
                imp.append(f"  {n},")
            imp.append(f'}} from "./{other}";')
    header = "\n".join(imp)
    decls = EXTRA_DECLS.get(mod)
    prefix = header + ("\n\n" + decls if decls else "")
    path.write_text(prefix + "\n\n" + body_text)
print("assembled")
