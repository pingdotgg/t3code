import re
import pathlib

BASE = pathlib.Path("/home/ben/audits/t3code-v0.1.7/apps/web/src/terminal/ghostty")
src = (BASE / "surface.ts").read_text().split("\n")
# 1-indexed accessor
L = lambda a, b: src[a - 1 : b]

MEMBERS = {
    # name: (start, end, kind)
    "onKeyDown": (1032, 1143, "arrow"),
    "onKeyUp": (1145, 1165, "arrow"),
    "onWindowKeyUp": (1167, 1171, "arrow"),
    "onWindowKeyDown": (1173, 1176, "arrow"),
    "onFocus": (1178, 1182, "arrow"),
    "onBlur": (1184, 1190, "arrow"),
    "primeCopy": (1204, 1207, "method"),
    "clearPrimedCopy": (1209, 1212, "method"),
    "onCopyEvent": (1214, 1228, "arrow"),
    "onPaste": (1230, 1244, "arrow"),
    "onCompositionStart": (1246, 1250, "arrow"),
    "onCompositionEnd": (1252, 1262, "arrow"),
    "onInput": (1264, 1276, "arrow"),
    "clearCompositionInputSuppression": (1278, 1284, "method"),
    "onPointerDown": (1286, 1339, "arrow"),
    "recordSelectionClick": (1341, 1349, "method"),
    "beginSelection": (1351, 1380, "method"),
    "onPointerMove": (1382, 1450, "arrow"),
    "extendSelectionTo": (1452, 1488, "method"),
    "setSelectionAutoscroll": (1490, 1506, "method"),
    "updateHoverCursor": (1508, 1511, "method"),
    "onPointerLeave": (1513, 1516, "arrow"),
    "clearHoveredLink": (1518, 1522, "method"),
    "refreshHoveredLink": (1524, 1528, "method"),
    "setHoveredLink": (1530, 1543, "method"),
    "onPointerUp": (1545, 1613, "arrow"),
    "onWheel": (1615, 1626, "arrow"),
    "scrollRows": (1628, 1644, "method"),
    "onMouseDown": (1646, 1651, "arrow"),
    "onMouseUp": (1654, 1656, "arrow"),
    "onContextMenu": (1658, 1664, "arrow"),
    "onScrollbarPointerDown": (1666, 1682, "arrow"),
    "onScrollbarPointerMove": (1684, 1688, "arrow"),
    "onScrollbarPointerUp": (1690, 1697, "arrow"),
    "onScrollbarKeyDown": (1699, 1728, "arrow"),
    "scrollViewport": (1791, 1805, "method"),
    "scrollbarToPointer": (1807, 1817, "method"),
    "updateScrollbar": (1819, 1838, "method"),
    "readScrollbarState": (1840, 1844, "method"),
    "requestRender": (1846, 1853, "method"),
    "cancelRender": (1855, 1865, "method"),
    "cancelSynchronizedRenderTimer": (1867, 1871, "method"),
    "deferSynchronizedRender": (1873, 1895, "method"),
    "renderFrame": (1897, 1964, "method"),
    "scheduleCursorBlink": (1966, 1975, "method"),
    "blinkEnabled": (1977, 1986, "method"),
    "positionInput": (1988, 2001, "method"),
    "cellAt": (2003, 2021, "method"),
    "linkAt": (2023, 2026, "method"),
    "findLinkAt": (2028, 2073, "method"),
    "sendMouse": (2075, 2100, "method"),
    "synchronizeMouseTrackingState": (2102, 2113, "method"),
    "buttonFromButtons": (2115, 2122, "method"),
    "installEvents": (1730, 1759, "method"),
    "removeEvents": (1761, 1789, "method"),
    "hasSelection": (919, 921, "method"),
    "getSelection": (923, 925, "method"),
    "getSelectionCellCount": (927, 931, "method"),
    "selectAll": (933, 944, "method"),
    "getSelectionPosition": (946, 954, "method"),
    "getSelectionEndClientRect": (956, 974, "method"),
    "clearSelection": (976, 988, "method"),
}

HANDLER_MODULES = {
    "surfaceKeyboard.ts": [
        "onKeyDown", "onKeyUp", "onWindowKeyUp", "onWindowKeyDown", "onFocus", "onBlur",
        "primeCopy", "clearPrimedCopy", "onCopyEvent", "onPaste", "onCompositionStart",
        "onCompositionEnd", "onInput", "clearCompositionInputSuppression",
    ],
    "surfacePointer.ts": [
        "onPointerDown", "recordSelectionClick", "beginSelection", "onPointerMove",
        "extendSelectionTo", "setSelectionAutoscroll", "updateHoverCursor", "onPointerLeave",
        "clearHoveredLink", "refreshHoveredLink", "setHoveredLink", "onPointerUp",
    ],
    "surfaceScrollbar.ts": [
        "onScrollbarPointerDown", "onScrollbarPointerMove", "onScrollbarPointerUp",
        "onScrollbarKeyDown", "scrollViewport", "scrollbarToPointer", "updateScrollbar",
        "readScrollbarState",
    ],
    "surfaceRender.ts": [
        "requestRender", "cancelRender", "cancelSynchronizedRenderTimer",
        "deferSynchronizedRender", "renderFrame", "scheduleCursorBlink", "blinkEnabled",
        "positionInput",
    ],
    "surfaceSelection.ts": [
        "hasSelection", "getSelection", "getSelectionCellCount", "selectAll",
        "getSelectionPosition", "getSelectionEndClientRect", "clearSelection",
    ],
    "surfaceEvents.ts": ["installEvents", "removeEvents"],
    "surfaceMouse.ts": [
        "onWheel", "scrollRows", "onMouseDown", "onMouseUp", "onContextMenu", "cellAt",
        "linkAt", "findLinkAt", "sendMouse", "synchronizeMouseTrackingState",
        "buttonFromButtons",
    ],
}

ASSIGNED = {name for names in HANDLER_MODULES.values() for name in names}


def dedent(lines, n=2):
    out = []
    for line in lines:
        out.append(line[n:] if line.startswith(" " * n) else line)
    return out


def convert(name, kind):
    start, end, _ = MEMBERS[name]
    raw = L(start, end)
    text = "\n".join(raw).rstrip()
    if not text.endswith("};") and not text.endswith("}"):
        raise SystemExit(f"unexpected tail for {name}: {text[-40:]!r}")
    body_text = text[: -1 if text.endswith("};") else len(text)] if False else None
    # strip trailing "};" or "}"
    tail = "};" if text.endswith("};") else "}"
    head = text[: len(text) - len(tail)].rstrip()
    lead = []
    while True:
        if head.startswith("  //"):
            first, _, head = head.partition("\n")
            lead.append(first)
        elif head.startswith("  /**") or head.startswith("  /*"):
            while True:
                first, _, head = head.partition("\n")
                lead.append(first)
                if first.rstrip().endswith("*/"):
                    break
        else:
            break
    head = head.lstrip("\n")
    if kind == "arrow":
        m = re.match(
            r"^  (?:private readonly |private )?(?P<name>\w+) = \((?P<args>[^)]*)\) => \{(?P<body>.*)\Z",
            head,
            re.S,
        )
    else:
        m = re.match(
            r"^  (?:private |readonly )?(?P<name>\w+)\((?P<args>.*?)\)(?:: .*?)? \{(?P<body>.*)\Z",
            head,
            re.S,
        )
    if not m:
        raise SystemExit(f"could not parse {name}:\n{head[:200]}")
    args = m.group("args").strip().replace("\n  ", "\n")
    body = m.group("body")
    body_lines = dedent(body.split("\n"))
    body = "\n".join(body_lines)
    body = re.sub(r"\bthis\.", "surface.", body)
    params = f"surface: GhosttyTerminalSurface" + (f", {args}" if args else "")
    params = params.replace("\n", "\n  ")
    return "\n".join(lead) + ("\n" if lead else "") + f"export function surface{name[0].upper() + name[1:]}({params}) {{{body}\n}}"


def split_params(args):
    parts, depth, cur = [], 0, ""
    for ch in args:
        if ch in "(<[{":
            depth += 1
        elif ch in ")>]}":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    return [p.strip() for p in parts if p.strip()]


def delegation(name, kind):
    start, end, _ = MEMBERS[name]
    raw = "\n".join(L(start, end))
    raw = re.sub(r"^(?:(?:  //.*|  /\*.*|  \*.*?)\n)+", "", raw)
    if kind == "arrow":
        m = re.match(r"^  (?:private readonly |private )?(?P<name>\w+) = \((?P<args>[^)]*)\) => \{", raw)
        args = m.group("args")
        params = split_params(args)
        names = [params[0].split(":")[0].strip()] if params else []
        call = ", ".join(["this"] + names)
        return f"  {m.group('name')} = ({args}) => surface{name[0].upper() + name[1:]}({call});"
    m = re.match(
        r"^  (?:private |readonly )?(?P<name>\w+)\((?P<args>.*?)\)(?:: (?P<ret>.*?))? \{",
        raw,
        re.S,
    )
    args = m.group("args")
    ret = re.sub(r"\s*\n\s*", " ", m.group("ret") or "").strip()
    names = [re.match(r"\s*(\w+)", a).group(1) for a in split_params(args)]
    call = ", ".join(["this"] + names)
    typed = re.sub(r"\s*\n\s*", " ", args)
    suffix = f": {ret}" if ret else ""
    call_expr = f"surface{name[0].upper() + name[1:]}({call})"
    stmt = f"return {call_expr}" if ret and ret not in ("void",) else call_expr
    return f"  {name}({typed}){suffix} {{ {stmt}; }}"


# Build new module bodies
modules = {}
for filename, names in HANDLER_MODULES.items():
    modules[filename] = [convert(name, MEMBERS[name][2]) for name in names]

# Rewrite surface.ts
starts = {start: (name, end, kind) for name, (start, end, kind) in MEMBERS.items()}
out = []
i = 1
while i <= len(src):
    if i in starts:
        name, end, kind = starts[i]
        out.append(delegation(name, kind))
        i = end + 1
        continue
    out.append(src[i - 1])
    i += 1

text = "\n".join(out)
(BASE / "surface.rewritten.tmp.ts").write_text(text)
for filename, bodies in modules.items():
    (BASE / filename.replace(".ts", ".body.tmp.ts")).write_text("\n\n".join(bodies))
print("wrote temp files")
print(len(text.split("\n")), "lines in rewritten surface")
