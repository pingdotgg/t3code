// Stand-in `ssh` for the device conformance check. It records each run (argv, the device
// variables of its environment, stdin) under $DEVICE_STUB_RECORDS and plays a Mac with Xcode:
// - `ssh -G <target>`: the resolved options of a host that is not this machine;
// - the Node bootstrap (`… exec node`, the script on stdin): answers its mode;
// - a command in the host's state folder (`cd … && exec 'xcrun' …`): simctl answers;
// - `ssh -L …`: the forward. It serves a stand-in expo-device-hub and agent-device daemon on the
//   forwarded loopback ports until its stdin ends, as the real forward lives until the server
//   closes its end.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

const argv = process.argv.slice(2);
const records = process.env.DEVICE_STUB_RECORDS;
let sequence = 0;

function record(kind, extra) {
  if (!records) return;
  NodeFS.mkdirSync(records, { recursive: true });
  const file = NodePath.join(records, `${Date.now()}-${process.pid}-${sequence++}-${kind}.json`);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(AGENT_DEVICE_|ELECTRON_RUN_AS_NODE$|ANDROID_HOME$|FORCE_COLOR$|NO_COLOR$)/.test(name),
    ),
  );
  NodeFS.writeFileSync(file, JSON.stringify({ kind, argv, env, ...extra }));
}

/** The words of a POSIX single-quoted shell text (`'a' 'b'"'"'c'`), outside quotes split on spaces. */
function shellWords(text) {
  const words = [];
  let word = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      word = (word ?? "") + text.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      const end = text.indexOf('"', i + 1);
      word = (word ?? "") + text.slice(i + 1, end);
      i = end;
    } else if (c === " " || c === "\n") {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

function readStdin() {
  try {
    return NodeFS.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** A PNG's chunk structure (2 × 3 pixels); the checks read structure, not pixels. */
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(2, 0);
header.writeUInt32BE(3, 4);
header[8] = 8;
header[9] = 6;
const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IEND", Buffer.alloc(0)),
]);

if (argv.includes("-G")) {
  record("resolve", { stdin: readStdin() });
  process.stdout.write("user stub\nhostname 192.0.2.10\nport 22\nproxycommand none\n");
  process.exit(0);
}

if (argv.includes("-L")) {
  forward();
} else {
  const dash = argv.indexOf("--");
  const remote = dash < 0 ? [] : argv.slice(dash + 2);
  const script = remote.length === 3 ? shellWords(remote[2]).join(" ") : remote.join(" ");
  const stdin = readStdin();
  if (script.endsWith("exec node") && stdin.length > 0) {
    bootstrap(stdin, remote);
  } else if (script.includes("&& exec ")) {
    command(remote, stdin);
  } else {
    record("other", { stdin });
    process.exit(0);
  }
}

function bootstrap(stdin, remote) {
  const mode = /const mode = "([^"]+)";/.exec(stdin)?.[1];
  const hub = /const hubVersion = "([^"]+)";/.exec(stdin)?.[1];
  const agent = /const agentVersion = "([^"]+)";/.exec(stdin)?.[1];
  record("bootstrap", { mode, remote, stdin });
  const platforms = [
    { platform: "ios", available: true },
    {
      platform: "android",
      available: false,
      reason: "Android SDK was not found. Install it with Android Studio or set ANDROID_HOME on the SSH host.",
    },
  ];
  const tools = {
    hub: { requiredVersion: hub, installedVersions: [hub], runningVersion: null },
    agent: { requiredVersion: agent, installedVersions: [agent], runningVersion: null },
  };
  if (mode === "probe") {
    process.stdout.write(`${JSON.stringify({ nodePath: "/remote/node", platforms, tools })}\n`);
  } else if (mode === "start" || mode === "agent-start") {
    process.stdout.write(
      `${JSON.stringify({
        nodePath: "/remote/node",
        platforms,
        tools,
        hubPort: 4100,
        ...(mode === "agent-start"
          ? { daemonPort: 4101, token: "stub-daemon-token", entryPath: "/remote/agent-device.mjs" }
          : {}),
        helpers: { serveSimAxSettings: "/remote/serve-sim-ax-settings", serveSimCli: "/remote/serve-sim.js" },
      })}\n`,
    );
  }
  process.exit(0);
}

function command(remote, stdin) {
  const inner = shellWords(remote[2] ?? "").join(" ");
  const words = shellWords(shellWords(remote[2] ?? "")[0] ?? "");
  const exec = words.indexOf("exec");
  const run = exec < 0 ? [] : words.slice(exec + 1);
  record("run", { run, stdin, inner: inner.length });
  const [program, ...args] = run;
  if (program === "xcrun" && args[0] === "simctl") {
    const [, verb, udid, ...rest] = args;
    if (verb === "ui" && rest.length === 1) {
      const answers = { appearance: "dark", content_size: "extra-extra-large", increase_contrast: "disabled" };
      process.stdout.write(`${answers[rest[0]] ?? ""}\n`);
    } else if (verb === "spawn" && rest.at(-1) === "status") {
      process.stdout.write(
        JSON.stringify({
          "reduce-motion": "on",
          "reduce-transparency": "off",
          "show-borders": "off",
          voiceover: "off",
          "liquid-glass": "tinted",
          "color-filter": "none",
        }),
      );
    }
    void udid;
  }
  process.exit(0);
}

function forward() {
  const devices = {
    "SIM-OFF": { id: "SIM-OFF", name: "iPhone 17", version: "iOS 26.0", platform: "ios", booted: false, physical: false },
    "SIM-ON": { id: "SIM-ON", name: "iPad Air", version: "iOS 27.0", platform: "ios", booted: true, physical: false },
  };
  const specs = [];
  argv.forEach((arg, i) => {
    if (arg === "-L") specs.push(argv[i + 1]);
  });
  record("forward", { stdin: "" });
  const servers = [];
  const json = (response, value, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  for (const spec of specs) {
    const [, localPort, , remotePort] = spec.split(":");
    const server = NodeHttp.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const url = new URL(request.url, "http://hub");
        record("hub", {
          stdin: "",
          port: remotePort,
          method: request.method,
          path: url.pathname,
          search: url.search,
          body,
          authorization: request.headers.authorization ?? null,
        });
        if (remotePort === "4101") {
          if (url.pathname === "/health") return json(response, { ok: true });
          if (url.pathname === "/rpc") return json(response, { jsonrpc: "2.0", id: "x", result: { ok: true } });
          return json(response, {}, 404);
        }
        if (url.pathname === "/readyz") return json(response, { ok: true });
        if (url.pathname === "/api/devices" && request.method === "GET")
          return json(response, { simulators: Object.values(devices), emulators: [], errors: [] });
        if (url.pathname === "/api/devices/boot") {
          const id = JSON.parse(body || "{}").id;
          if (devices[id]) devices[id].booted = true;
          return json(response, { ok: true, id });
        }
        if (url.pathname === "/vendor/serve-sim/grid/api/start") return json(response, { ok: true });
        if (url.pathname === "/vendor/serve-sim/grid/api/shutdown") {
          const id = JSON.parse(body || "{}").udid;
          if (devices[id]) devices[id].booted = false;
          return json(response, { ok: true });
        }
        if (url.pathname.endsWith("/api/screenshot")) {
          response.writeHead(200, { "content-type": "image/png" });
          return response.end(Buffer.concat([Buffer.from("warning: two displays\n"), PNG]));
        }
        if (url.pathname.endsWith("/stream.mjpeg")) {
          response.writeHead(200, {
            "content-type": "multipart/x-mixed-replace; boundary=frame",
            "set-cookie": "hub=1",
          });
          const frame = Buffer.from("JPEGDATA");
          response.write(
            Buffer.concat([
              Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`),
              frame,
              Buffer.from("\r\n"),
            ]),
          );
          return;
        }
        return json(response, { error: "not found" }, 404);
      });
    });
    server.listen(Number(localPort), "127.0.0.1");
    servers.push(server);
  }
  // Live until the server closes its end of stdin, as `exec cat >/dev/null` on the host.
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}
