#!/usr/bin/env python3
"""Create a credential-free Codex project-trust reproduction in a new directory.

Usage: python3 scripts/fixtures/seed-codex-project-mcp.py /tmp/codex-mcp-fixture

Select project/ as the T3 project and wire the provider to codex-home-untrusted/
or codex-home-trusted/. Authentication is a separate, private operator step.
Ask: Call issue15140_probe and report its result. Do not edit project trust.
This seeds local MCP data only; it does not start processes or modify T3 state.
"""

import argparse
import json
from pathlib import Path


MCP_SERVER = '''import json
import sys

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request.get("method")
    if method == "initialize":
        result = {
            "protocolVersion": request.get("params", {}).get("protocolVersion", "2024-11-05"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "issue15140", "version": "1"},
        }
    elif method == "tools/list":
        result = {"tools": [{
            "name": "issue15140_probe",
            "description": "Report whether this project-local MCP server loaded",
            "inputSchema": {"type": "object", "properties": {}},
        }]}
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": "issue15140_probe: loaded"}]}
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
'''

FROZEN_CLOCK = '''const OriginalDate = globalThis.Date;
const instant = OriginalDate.parse("2026-10-22T08:05:00.000Z");
globalThis.Date = class extends OriginalDate {
  constructor(...args) {
    if (args.length === 0) super(instant);
    else super(...args);
  }
  static now() { return instant; }
};
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    root = args.destination.expanduser().resolve()
    # Refusing an existing destination protects private homes and earlier captures.
    root.mkdir(parents=True, exist_ok=False)
    project = root / "project"
    (project / ".codex").mkdir(parents=True)
    server = root / "mcp.py"
    server.write_text(MCP_SERVER, encoding="utf-8")
    (root / "freeze-clock.mjs").write_text(FROZEN_CLOCK, encoding="utf-8")
    (project / ".codex" / "config.toml").write_text(
        '[mcp_servers.issue15140]\ncommand = "python3"\n'
        f"args = [{json.dumps(str(server), ensure_ascii=False)}]\n",
        encoding="utf-8",
    )
    for trust in ("untrusted", "trusted"):
        home = root / f"codex-home-{trust}"
        home.mkdir(mode=0o700)
        (home / "config.toml").write_text(
            f"[projects.{json.dumps(str(project), ensure_ascii=False)}]\ntrust_level = \"trusted\"\n"
            if trust == "trusted" else "",
            encoding="utf-8",
        )
    print(f"Created credential-free local MCP fixture: {root}")
    print("Project: project/; provider homes: codex-home-untrusted/, codex-home-trusted/")
    print("Prompt: Call issue15140_probe and report its result. Do not edit project trust.")


if __name__ == "__main__":
    main()
