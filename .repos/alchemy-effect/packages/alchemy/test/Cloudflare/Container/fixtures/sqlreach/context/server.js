// Probe server for container → SQL DATABASE_URL reachability. Plain node,
// no deps. `/env` reports the URL the process received (and duplicate-key
// count from the raw environ — glibc getenv is first-match). `/probe`
// TCP-connects to that URL from inside the container.
//
// NOTE: this file is force-added past the repo's `*.js` ignore rule.
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");

const countEnv = (name) => {
  try {
    return fs
      .readFileSync("/proc/self/environ", "utf8")
      .split("\0")
      .filter((entry) => entry.startsWith(`${name}=`)).length;
  } catch {
    return undefined;
  }
};

const defaultPort = (url) => {
  if (url.port) return Number(url.port);
  if (url.protocol.startsWith("mysql")) return 3306;
  return 5432;
};

const tcpProbe = (hostname, port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port }, () => {
      socket.end();
      resolve({ ok: true, host: hostname, port });
    });
    socket.setTimeout(8000, () => {
      socket.destroy();
      resolve({ ok: false, host: hostname, port, error: "timeout" });
    });
    socket.on("error", (error) =>
      resolve({ ok: false, host: hostname, port, error: String(error) }),
    );
  });

const server = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/env") {
    res.end(
      JSON.stringify({
        DATABASE_URL: process.env.DATABASE_URL,
        databaseUrlCount: countEnv("DATABASE_URL"),
      }),
    );
    return;
  }
  if (req.url === "/probe") {
    const value = process.env.DATABASE_URL;
    if (!value) {
      res.end(JSON.stringify({ error: "missing DATABASE_URL" }));
      return;
    }
    try {
      const url = new URL(value);
      res.end(JSON.stringify(await tcpProbe(url.hostname, defaultPort(url))));
    } catch (error) {
      res.end(JSON.stringify({ error: String(error) }));
    }
    return;
  }
  res.end(JSON.stringify({ ok: true }));
});

server.listen(8080, () => {
  console.log("sqlreach probe server listening on 8080");
});
