#!/usr/bin/env python3
"""Sends automation commands to a running conn-app (built with --features automation).

  scripts/automate.py '{"cmd":"dump"}' '{"cmd":"screenshot","path":".shots/a.png"}'

Reads the port from $CONN_GPUI_AUTOMATION (default /tmp/conn-gpui-dev/automation-port).
"""
import json, os, socket, sys

port_file = os.environ.get("CONN_GPUI_AUTOMATION", "/tmp/conn-gpui-dev/automation-port")
port = int(open(port_file).read().strip())
with socket.create_connection(("127.0.0.1", port), timeout=30) as s:
    f = s.makefile("rw")
    for arg in sys.argv[1:]:
        f.write(arg.strip() + "\n"); f.flush()
        reply = json.loads(f.readline())
        print(json.dumps(reply, indent=2) if "dump" in arg else json.dumps(reply))
        if "error" in reply:
            sys.exit(1)
