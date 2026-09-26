// Probe server for the #1334 host-reach regression test. Plain node, no
// deps. `/env` reports the env the container actually received (so the test
// can assert the loopback rewrite); `/probe` fetches TARGET_URL from INSIDE
// the container and reports what came back — the proof that a value written
// as `http://localhost:…` still reaches the developer machine.
//
// NOTE: this file is force-added past the repo's `*.js` ignore rule — the
// docker build COPYs it, so a checkout without it fails the container boot.
const http = require("node:http");

const server = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/env") {
    res.end(
      JSON.stringify({
        TARGET_URL: process.env.TARGET_URL,
        PPG_URL: process.env.PPG_URL,
        NEON_URL: process.env.NEON_URL,
        PLANETSCALE_PG_URL: process.env.PLANETSCALE_PG_URL,
        PLANETSCALE_MYSQL_URL: process.env.PLANETSCALE_MYSQL_URL,
      }),
    );
    return;
  }
  if (req.url === "/probe") {
    try {
      const response = await fetch(process.env.TARGET_URL);
      const body = await response.text();
      res.end(JSON.stringify({ status: response.status, body }));
    } catch (error) {
      res.end(JSON.stringify({ error: String(error) }));
    }
    return;
  }
  res.end(JSON.stringify({ ok: true }));
});

server.listen(8080, () => {
  console.log("hostreach probe server listening on 8080");
});
