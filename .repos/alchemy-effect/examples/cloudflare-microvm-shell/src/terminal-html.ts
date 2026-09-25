/**
 * The terminal SPA, served inline by the Worker so `alchemy dev` is a single
 * command with no separate front-end build. It is a hand-rolled terminal (no
 * xterm.js): a scrollback pane + a prompt input that opens a WebSocket to the
 * session Durable Object, sends each command, and appends streamed output as
 * it arrives.
 */
export const TERMINAL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MicroVM Shell</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; display: flex; flex-direction: column;
    background: #0b0e14; color: #d7dce2;
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  header {
    padding: 10px 16px; border-bottom: 1px solid #1c2230;
    color: #7dcfff; letter-spacing: .04em; font-weight: 600;
    display: flex; justify-content: space-between; align-items: center;
  }
  header .status { font-weight: 400; color: #565f73; }
  header .status.live { color: #9ece6a; }
  #screen {
    flex: 1; overflow-y: auto; padding: 16px; white-space: pre-wrap;
    word-break: break-word;
  }
  #screen .cmd { color: #7dcfff; }
  #screen .sys { color: #565f73; }
  #screen .exit { color: #e0af68; }
  form { display: flex; border-top: 1px solid #1c2230; }
  .prompt { padding: 12px 8px 12px 16px; color: #9ece6a; }
  input {
    flex: 1; background: transparent; border: 0; outline: 0;
    color: #d7dce2; font: inherit; padding: 12px 16px 12px 0;
  }
</style>
</head>
<body>
<header>
  <span>microvm@shell</span>
  <span class="status" id="status">connecting…</span>
</header>
<div id="screen"></div>
<form id="form">
  <span class="prompt">$</span>
  <input id="input" autocomplete="off" autofocus placeholder="type a command, e.g. uname -a" />
</form>
<script type="module">
  const screen = document.getElementById("screen");
  const input = document.getElementById("input");
  const form = document.getElementById("form");
  const status = document.getElementById("status");

  const append = (text, cls) => {
    const span = document.createElement("span");
    if (cls) span.className = cls;
    span.textContent = text;
    screen.appendChild(span);
    screen.scrollTop = screen.scrollHeight;
  };

  const sessionId = Math.random().toString(36).slice(2, 10);
  const wsUrl = new URL(location.href);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.pathname = "/session/" + sessionId + "/ws";
  const ws = new WebSocket(wsUrl);

  ws.addEventListener("open", () => {
    status.textContent = "● live";
    status.className = "status live";
    input.focus();
  });
  ws.addEventListener("message", (e) => append(e.data));
  ws.addEventListener("close", () => {
    status.textContent = "closed";
    status.className = "status";
    append("[connection closed]\\n", "sys");
  });
  ws.addEventListener("error", () => append("[socket error]\\n", "sys"));

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const command = input.value;
    if (!command.trim()) return;
    append("$ " + command + "\\n", "cmd");
    ws.send(command);
    input.value = "";
  });
</script>
</body>
</html>`;
