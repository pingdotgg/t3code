const http = require("node:http"),
  fs = require("node:fs");
const path = require("node:path"),
  { parseArgs } = require("node:util");
const { values } = parseArgs({
  options: {
    checkout: { type: "string" },
    fixtures: { type: "string" },
    port: { type: "string", default: "15516" },
    "upstream-port": { type: "string", default: "15404" },
  },
});
if (!values.checkout || !values.fixtures)
  throw new Error("Required: --checkout <checkout> --fixtures <fixture-output-directory>");
const fixtures = path.resolve(values.fixtures),
  port = Number(values.port),
  upstreamPort = Number(values["upstream-port"]);
if (![port, upstreamPort].every((p) => Number.isInteger(p) && p > 0 && p < 65536))
  throw new Error("Ports must be integers from 1 through 65535");
const checkout = path.resolve(values.checkout);
const { WebSocketServer, WebSocket } = require(
  require.resolve("ws", { paths: [checkout, path.join(checkout, "node_modules/.pnpm")] }),
);
const links = JSON.parse(fs.readFileSync(path.join(fixtures, "links.json")));
const local = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: true,
  refName: "main",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};
const b3 = {
  number: 3,
  title: "Checkout branch change",
  url: "https://github.com/example/fixture/pull/3",
  baseRef: "release",
  headRef: "main",
  state: "open",
  isDraft: false,
  updatedAt: null,
};
const remote = (cwd) => ({
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  pr: cwd?.includes("workspace-f4") ? b3 : null,
});
const config = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(fixtures, "mode.json")));
  } catch {
    return { cap: true };
  }
};
function rewrite(v) {
  if (Array.isArray(v)) return v.map(rewrite);
  if (!v || typeof v !== "object") return v;
  for (const k of Object.keys(v)) v[k] = rewrite(v[k]);
  if (v.capabilities && typeof v.capabilities === "object") {
    v.capabilities.threadPullRequests = config().cap;
    v.capabilities.threadPullRequestWatch = config().cap;
  }
  if (
    typeof v.id === "string" &&
    v.id.startsWith("remote-command-center") &&
    Array.isArray(v.pullRequests)
  ) {
    const f = v.id === "remote-command-center" ? "f1" : v.id.replace("remote-command-center-", "");
    if (links[f]) v.pullRequests = links[f];
  }
  return v;
}
const server = http.createServer((req, res) => {
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: upstreamPort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: "127.0.0.1:" + upstreamPort },
    },
    (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        let body = Buffer.concat(chunks);
        const headers = { ...r.headers };
        if ((headers["content-type"] || "").includes("json")) {
          try {
            body = Buffer.from(JSON.stringify(rewrite(JSON.parse(body.toString()))));
            delete headers["content-length"];
          } catch {}
        }
        res.writeHead(r.statusCode, headers);
        res.end(body);
      });
    },
  );
  upstream.on("error", () => {
    res.writeHead(502);
    res.end("Fixture backend unavailable");
  });
  req.pipe(upstream);
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, sock, head) =>
  wss.handleUpgrade(req, sock, head, (client) => {
    const upstream = new WebSocket("ws://127.0.0.1:" + upstreamPort + req.url, {
      headers: {
        ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        host: "127.0.0.1:" + upstreamPort,
      },
    });
    const pending = [];
    const mocked = new Set();
    function send(v) {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(v));
    }
    function onInput(data) {
      let v;
      try {
        v = JSON.parse(data.toString());
      } catch {
        upstream.send(data);
        return;
      }
      if (
        v._tag === "Request" &&
        (v.tag === "subscribeVcsStatus" || v.tag === "vcs.refreshStatus")
      ) {
        mocked.add(String(v.id));
        const cwd = v.payload.cwd;
        const status = { ...local, ...remote(cwd) };
        fs.appendFileSync(
          path.join(fixtures, "observed-safe.log"),
          JSON.stringify({
            type: "pinned-vcs",
            method: v.tag,
            fixture: cwd?.includes("workspace-f4") ? "F4" : "S0",
            status,
          }) + "\n",
        );
        if (v.tag === "subscribeVcsStatus")
          send({
            _tag: "Chunk",
            requestId: v.id,
            values: [{ _tag: "snapshot", local, remote: remote(cwd) }],
          });
        else send({ _tag: "Exit", requestId: v.id, exit: { _tag: "Success", value: status } });
        return;
      }
      if (v.requestId !== undefined && mocked.has(String(v.requestId))) return;
      upstream.send(data);
    }
    client.on("message", (data) => {
      if (upstream.readyState === WebSocket.OPEN) onInput(data);
      else pending.push(data);
    });
    upstream.on("open", () => pending.splice(0).forEach(onInput));
    upstream.on("message", (data) => {
      try {
        const v = rewrite(JSON.parse(data.toString()));
        send(v);
      } catch {
        if (client.readyState === 1) client.send(data);
      }
    });
    upstream.on("error", (e) => {
      console.error("Upstream transport error", e.code, e.message);
      client.close();
    });
    client.on("error", () => upstream.close());
    client.on("close", () => upstream.close());
    upstream.on("close", () => client.close());
  }),
);
server.listen(port, "127.0.0.1", () =>
  console.log("Fixture proxy listening on " + port + "; isolated backend " + upstreamPort),
);
