export const enterpriseBrowserBridgeSource = (marker: string) => String.raw`
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

if (process.argv[2] === "--open") {
  const socket = net.createConnection(process.env.T3_ENTERPRISE_BROWSER_SOCKET);
  socket.on("error", () => process.exit(1));
  socket.on("connect", () => socket.end(JSON.stringify(process.argv[3])));
} else {
  const directory = fs.mkdtempSync("/tmp/t3-agy-browser-");
  const endpoint = path.join(directory, "browser.sock");
  const launcher = path.join(directory, "xdg-open");
  const quote = (value) => "'" + value.replaceAll("'", "'" + '"' + "'" + '"' + "'") + "'";
  fs.writeFileSync(launcher,
    "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(__filename) + ' --open "$1"\n',
    { mode: 0o700 });
  let child;
  let failed = false;
  const server = net.createServer((socket) => {
    let data = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("error", fail);
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.length > 65536) {
        socket.destroy();
        fail();
      }
    });
    socket.on("end", () => {
      try {
        const url = JSON.parse(data);
        if (typeof url !== "string" || url.length > 16384) throw new Error();
        process.stderr.write(${JSON.stringify(marker)} + JSON.stringify(url) + "\n");
      } catch {
        fail();
      }
      socket.end();
    });
  });
  function finish(code) {
    server.close(() => {
      fs.rmSync(directory, { recursive: true, force: true });
      process.exitCode = code;
    });
  }
  function fail() {
    if (failed) return;
    failed = true;
    process.stderr.write("Antigravity Enterprise browser bridge failed.\n");
    if (child?.pid) child.kill();
    else finish(1);
  }
  server.on("error", fail);
  server.listen(endpoint, () => {
    fs.chmodSync(endpoint, 0o600);
    const env = {
      ...process.env,
      T3_ENTERPRISE_BROWSER_SOCKET: endpoint,
      PATH: directory + ":" + (process.env.PATH || "/usr/bin:/bin"),
      DISPLAY: process.env.DISPLAY || ":0",
      BROWSER: launcher,
    };
    delete env.SSH_CONNECTION;
    delete env.SSH_CLIENT;
    delete env.SSH_TTY;
    child = spawn(process.argv[2], process.argv.slice(3), { env, stdio: "inherit" });
    child.on("error", fail);
    child.on("exit", (code, signal) => finish(failed ? 1 : code ?? (signal === "SIGINT" ? 130 : 143)));
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(signal, () => child.kill(signal));
    }
  });
}
`;
