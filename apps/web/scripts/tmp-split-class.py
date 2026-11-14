"""Generic mechanical splitter: moves class members to sibling modules and leaves
one-line delegations behind. Code is copied verbatim; only `this.` -> `<host>.`
and indentation change.

usage: python3 tmp-split-class.py <base dir> <file> <Class> <prefix> <plan.json>
"""
import json
import re
import sys
import pathlib

BASE = pathlib.Path(sys.argv[1])
FILENAME = sys.argv[2]
CLASS = sys.argv[3]
PREFIX = sys.argv[4].lower()
plan = json.loads(pathlib.Path(sys.argv[5]).read_text())
lines = (BASE / FILENAME).read_text().split("\n")
MEMBERS = {name: tuple(spec) for name, spec in plan["members"].items()}


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


def strip_lead(head):
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
    return lead, head.lstrip("\n")


def convert(name):
    start, end, kind = MEMBERS[name]
    text = "\n".join(lines[start - 1 : end]).rstrip()
    tail = "};" if text.endswith("};") else "}"
    head = text[: len(text) - len(tail)].rstrip()
    lead, head = strip_lead(head)
    if kind == "arrow":
        m = re.match(
            r"^  (?:private readonly |private )?(?P<name>\w+) = \((?P<args>[^)]*)\) => \{(?P<body>.*)\Z",
            head,
            re.S,
        )
    else:
        m = re.match(
            r"^  (?:private |readonly |public )?(?P<name>\w+)\((?P<args>.*?)\)(?:: .*?)? \{(?P<body>.*)\Z",
            head,
            re.S,
        )
    args = m.group("args").strip()
    body = "\n".join(l[2:] if l.startswith("  ") else l for l in m.group("body").split("\n"))
    body = re.sub(r"\bthis\.", f"{PREFIX}.", body)
    params = f"{PREFIX}: {CLASS}" + (f", {args}" if args else "")
    return (
        "\n".join(lead)
        + ("\n" if lead else "")
        + f"export function {PREFIX}{name[0].upper() + name[1:]}({params}) {{{body}\n}}"
    )


def delegation(name):
    start, end, kind = MEMBERS[name]
    raw = "\n".join(lines[start - 1 : end])
    raw = re.sub(r"^(?:(?:  //.*|  /\*.*|  \*.*?)\n)+", "", raw)
    if kind == "arrow":
        m = re.match(r"^  (?:private readonly |private )?(?P<name>\w+) = \((?P<args>[^)]*)\) => \{", raw)
        args = m.group("args")
        params = split_params(args)
        names = [params[0].split(":")[0].strip()] if params else []
        call = ", ".join(["this"] + names)
        return f"  {m.group('name')} = ({args}) => {PREFIX}{name[0].upper() + name[1:]}({call});"
    m = re.match(
        r"^  (?:private |readonly |public )?(?P<name>\w+)\((?P<args>.*?)\)(?:: (?P<ret>.*?))? \{",
        raw,
        re.S,
    )
    args = m.group("args")
    ret = re.sub(r"\s*\n\s*", " ", m.group("ret") or "").strip()
    names = [re.match(r"\s*(\w+)", a).group(1) for a in split_params(args)]
    call = ", ".join(["this"] + names)
    typed = re.sub(r"\s*\n\s*", " ", args)
    suffix = f": {ret}" if ret else ""
    call_expr = f"{PREFIX}{name[0].upper() + name[1:]}({call})"
    stmt = f"return {call_expr}" if ret and ret != "void" else call_expr
    return f"  {name}({typed}){suffix} {{ {stmt}; }}"


for mod, names in plan["modules"].items():
    header = list(plan["headers"].get(mod, []))
    bodies = [convert(n) for n in names]
    (BASE / mod).write_text("\n".join(header + [""] + bodies) + "\n")

starts = {v[0]: n for n, v in MEMBERS.items()}
out = []
i = 1
while i <= len(lines):
    if i in starts:
        name = starts[i]
        out.append(delegation(name))
        i = MEMBERS[name][1] + 1
        continue
    out.append(lines[i - 1])
    i += 1
(BASE / (FILENAME + ".new")).write_text("\n".join(out))
print("split", FILENAME, "->", len(out), "lines")
