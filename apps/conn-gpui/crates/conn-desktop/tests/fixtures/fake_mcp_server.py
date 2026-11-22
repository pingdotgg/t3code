"""A tiny MCP server over stdio for conn-desktop's tests.

Tools are listed over two pages. `echo` answers with its message; `fail` answers with a
JSON-RPC error; `exit` makes the server quit; `spawn` starts a grandchild in the same process
group and answers with its pid. The server pings the client once after initialization, and
writes to stderr on start.
"""

import json
import os
import subprocess
import sys

TOOLS = [
    {"name": "echo", "description": "Echo a message.",
     "inputSchema": {"type": "object", "properties": {"message": {"type": "string"}},
                     "required": ["message"]}},
    {"name": "fail", "inputSchema": {"type": "object"}},
    {"name": "exit", "inputSchema": {"type": "object"}},
    {"name": "spawn", "inputSchema": {"type": "object"}},
]


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def result(request_id, value):
    send({"jsonrpc": "2.0", "id": request_id, "result": value})


def main():
    sys.stderr.write("fake server starting\n")
    sys.stderr.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        message = json.loads(line)
        method = message.get("method")
        request_id = message.get("id")
        params = message.get("params") or {}
        if method is None:
            continue  # a response to our ping
        if method == "initialize":
            result(request_id, {
                "protocolVersion": params.get("protocolVersion"),
                "capabilities": {"tools": {"listChanged": True}, "resources": {}, "prompts": {}},
                "serverInfo": {"name": "fake", "title": "Fake Server", "version": "0.0.1"},
                "instructions": "Test only.",
            })
        elif method == "notifications/initialized":
            send({"jsonrpc": "2.0", "id": "srv-1", "method": "ping"})
        elif method == "ping":
            result(request_id, {})
        elif method == "tools/list":
            if params.get("cursor") == "page2":
                result(request_id, {"tools": TOOLS[2:]})
            else:
                result(request_id, {"tools": TOOLS[:2], "nextCursor": "page2"})
        elif method == "tools/call":
            name = params.get("name")
            args = params.get("arguments") or {}
            if name == "echo":
                result(request_id, {"content": [{"type": "text", "text": args.get("message", "")}]})
            elif name == "fail":
                send({"jsonrpc": "2.0", "id": request_id,
                      "error": {"code": -32602, "message": "Tool failed on purpose"}})
            elif name == "spawn":
                child = subprocess.Popen(["sleep", "60"])
                result(request_id, {"content": [{"type": "text", "text": str(child.pid)}]})
            elif name == "exit":
                sys.stderr.write("bye\n")
                sys.stderr.flush()
                os._exit(0)
        elif method == "resources/list":
            result(request_id, {"resources": [{"uri": "mem://a", "name": "a"}]})
        elif method == "resources/templates/list":
            result(request_id, {"resourceTemplates": [{"uriTemplate": "mem://{id}", "name": "t"}]})
        elif method == "prompts/list":
            result(request_id, {"prompts": [{"name": "greet", "arguments": [{"name": "who"}]}]})
        elif request_id is not None:
            send({"jsonrpc": "2.0", "id": request_id,
                  "error": {"code": -32601, "message": "Method not found"}})


main()
