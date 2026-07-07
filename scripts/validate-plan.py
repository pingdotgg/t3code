#!/usr/bin/env python3
"""Validate a design document's PR Plan section.

Usage:
    python3 scripts/validate-plan.py <design-doc-path>

Vendored from Grok execute-plan skill for in-repo agent preflight.
"""

import json
import re
import sys
from collections import defaultdict, deque

# Copied from ~/.grok/bundled/skills/execute-plan/scripts/validate-plan.py


def _strip_fenced_code_blocks(content):
    flags = re.MULTILINE | re.DOTALL
    content = re.sub(r"^\s*```[^\n]*\n.*?^\s*```\s*$", "", content, flags=flags)
    return re.sub(r"^\s*~~~[^\n]*\n.*?^\s*~~~\s*$", "", content, flags=flags)


def parse_pr_plan(content):
    stripped = _strip_fenced_code_blocks(content)
    heading = re.search(r"^## PR Plan\s*$", stripped, re.MULTILINE)
    if heading is None:
        return None, ["No '## PR Plan' section found in the document"]

    start = heading.end()
    next_section = re.search(r"^## (?!PR Plan\s*$)", stripped[start:], re.MULTILINE)
    section = stripped[start : start + next_section.start()] if next_section else stripped[start:]

    pr_re = re.compile(r"^###\s+PR\s+(\S+?):\s*(.+)$", re.MULTILINE)
    matches = list(pr_re.finditer(section))

    if not matches:
        return None, ["No PR entries found in the PR Plan section"]

    entries = []
    parse_errors = []
    for i, m in enumerate(matches):
        pr_num = m.group(1)
        title = m.group(2).strip()
        body_start = m.end()
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(section)
        body = section[body_start:body_end]

        files_raw = _extract_field(body, "Files/components affected")
        deps_raw = _extract_field(body, "Dependencies")
        description = _extract_field(body, "Description") or ""

        files = [f.strip() for f in files_raw.split(",") if f.strip()] if files_raw else []
        dependencies, dep_errors = _parse_dependencies(deps_raw, "PR {}".format(pr_num))
        parse_errors.extend(dep_errors)

        entries.append(
            {
                "id": "pr-{}".format(pr_num.lower()),
                "number": pr_num,
                "title": title,
                "files": files,
                "dependencies": dependencies,
                "description": description,
            }
        )

    if parse_errors:
        return None, parse_errors
    return entries, []


def _extract_field(body, field_name):
    escaped = re.escape(field_name)
    pattern = re.compile(
        rf"^\s*[-*]\s+\**{escaped}:?\**:?\s*(.+(?:\n[ \t]+\S.*)*)",
        re.MULTILINE | re.IGNORECASE,
    )
    m = pattern.search(body)
    if m:
        return re.sub(r"\s*\n[ \t]+", " ", m.group(1)).strip()
    return None


def _parse_dependencies(deps_raw, pr_label):
    if not deps_raw:
        return [], []
    stripped = deps_raw.strip()
    if stripped.lower() in ("none", "n/a", "-", ""):
        return [], []

    parts = [p.strip() for p in stripped.split(",")]
    deps = []
    errors = []
    for part in parts:
        if not part:
            continue
        m = re.match(r"PR\s+(\S+)", part, re.IGNORECASE)
        if m:
            deps.append("pr-{}".format(m.group(1).lower()))
        else:
            errors.append(
                "Unrecognized dependency format '{}' in {} (expected 'PR <id>')".format(
                    part, pr_label
                )
            )
    return deps, errors


def validate_dag(entries):
    errors = []
    seen = set()
    for entry in entries:
        if entry["id"] in seen:
            errors.append("Duplicate PR ID: '{}'".format(entry["id"]))
        seen.add(entry["id"])

    for entry in entries:
        for dep in entry["dependencies"]:
            if dep not in seen:
                dep_label = dep.replace("pr-", "PR ", 1)
                entry_label = entry["id"].replace("pr-", "PR ", 1)
                errors.append(
                    "Dependency '{}' in {} does not reference a valid PR ID".format(
                        dep_label, entry_label
                    )
                )

    if not errors:
        errors.extend(_detect_cycles(entries))
    return errors


def _detect_cycles(entries):
    in_degree = {e["id"]: 0 for e in entries}
    children = defaultdict(list)
    dep_map = {e["id"]: e["dependencies"] for e in entries}

    for entry in entries:
        for dep in entry["dependencies"]:
            children[dep].append(entry["id"])
            in_degree[entry["id"]] += 1

    queue = deque(eid for eid, deg in in_degree.items() if deg == 0)
    visited = 0

    while queue:
        node = queue.popleft()
        visited += 1
        for child in children[node]:
            in_degree[child] -= 1
            if in_degree[child] == 0:
                queue.append(child)

    if visited == len(entries):
        return []

    unvisited = [e["id"] for e in entries if in_degree[e["id"]] > 0]
    return ["Cycle detected involving: {}".format(", ".join(sorted(unvisited)))]


def _pr_sort_key(pr_id):
    suffix = pr_id.split("-", 1)[1] if "-" in pr_id else pr_id
    try:
        return (0, int(suffix), "")
    except ValueError:
        return (1, 0, suffix)


def compute_levels(entries):
    children = defaultdict(list)
    in_degree = {e["id"]: 0 for e in entries}

    for e in entries:
        for dep in e["dependencies"]:
            children[dep].append(e["id"])
            in_degree[e["id"]] += 1

    levels = {}
    queue = deque()
    for eid, deg in in_degree.items():
        if deg == 0:
            levels[eid] = 0
            queue.append(eid)

    while queue:
        node = queue.popleft()
        for child in children[node]:
            candidate = levels[node] + 1
            levels[child] = max(levels.get(child, 0), candidate)
            in_degree[child] -= 1
            if in_degree[child] == 0:
                queue.append(child)

    return levels


def linearize(entries, levels):
    by_level = defaultdict(list)
    for e in entries:
        by_level[levels[e["id"]]].append(e["id"])

    order = []
    for lv in sorted(by_level):
        order.extend(sorted(by_level[lv], key=_pr_sort_key))
    return order


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"valid": False, "errors": ["Usage: validate-plan.py <path>"]}, indent=2))
        sys.exit(2)

    path = sys.argv[1]
    try:
        with open(path, "r") as fh:
            content = fh.read()
    except OSError as exc:
        print(json.dumps({"valid": False, "errors": [str(exc)]}, indent=2))
        sys.exit(2)

    entries, parse_errors = parse_pr_plan(content)
    if parse_errors:
        print(json.dumps({"valid": False, "errors": parse_errors}, indent=2))
        sys.exit(1)

    errors = validate_dag(entries)
    if errors:
        print(json.dumps({"valid": False, "errors": errors}, indent=2))
        sys.exit(1)

    levels = compute_levels(entries)
    order = linearize(entries, levels)
    num_levels = max(levels.values()) + 1 if levels else 0
    counts = defaultdict(int)
    for lv in levels.values():
        counts[lv] += 1

    print(
        json.dumps(
            {
                "valid": True,
                "pr_count": len(entries),
                "levels": num_levels,
                "max_parallelism": max(counts.values()) if counts else 0,
                "linearized_order": order,
                "level_assignments": {pid: levels[pid] for pid in order},
                "errors": [],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()