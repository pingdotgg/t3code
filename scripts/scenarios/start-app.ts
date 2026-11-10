// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
// The app command of e2e.config.ts: starts this checkout's dev stack on a fresh T3 home.
// Run from the checkout whose app should start.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeTimersPromises from "node:timers/promises";

const [surface, home, ...ports] = process.argv.slice(2);
if ((surface !== "web" && surface !== "mobile") || home === undefined || ports.length === 0) {
  throw new Error(
    "Usage: start-app.ts web <t3-home> <web-port> | mobile <t3-home> <server-port> <metro-port> <host>",
  );
}

// The dev runner's web port is 5733 plus an offset. Mirror of BASE_WEB_PORT in dev-runner.ts.
const BASE_WEB_PORT = 5733;
// The replay agent `vp run dev` registers: free, recorded turns through the real adapter.
const REPLAY = { instanceId: "devReplay", model: "showcase" };

// The server labels its environment with the host's name, probed through these commands.
// Captures must not depend on, or show, the machine that made them.
const HOST_LABEL_SHIM = `#!/bin/sh
case "$*" in
  "--pretty" | "--get ComputerName") echo "Scenario" ;;
  *) for real in /usr/bin /usr/sbin /bin; do
       [ -x "$real/$(basename "$0")" ] && exec "$real/$(basename "$0")" "$@"
     done
     exit 127 ;;
esac
`;

NodeFS.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
NodeFS.mkdirSync(NodePath.join(home, "bin"));
for (const command of ["hostnamectl", "scutil"]) {
  NodeFS.writeFileSync(NodePath.join(home, "bin", command), HOST_LABEL_SHIM, { mode: 0o755 });
}
// New threads and generated text (titles) go to the replay agent, so no run reaches a paid model.
NodeFS.writeFileSync(
  NodePath.join(home, "userdata/settings.json"),
  JSON.stringify({ defaultModelSelection: REPLAY, textGenerationModelSelection: REPLAY }),
);

const env = {
  ...process.env,
  PATH: `${NodePath.join(home, "bin")}${NodePath.delimiter}${process.env.PATH ?? ""}`,
  T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
};
const children: Array<NodeChildProcess.ChildProcess> = [];
const start = (
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  extra: NodeJS.ProcessEnv,
) => {
  const child = NodeChildProcess.spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...env, ...extra },
  });
  children.push(child);
  child.on("exit", (code) => process.exit(code ?? 1));
  return child;
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => children.forEach((child) => child.kill(signal)));
}
const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });

if (surface === "web") {
  const [webPort] = ports;
  const serverPort = await new Promise<number>((resolve) => {
    const probe = NodeNet.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as NodeNet.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
  const runner = start(
    process.cwd(),
    process.execPath,
    ["scripts/dev-runner.ts", "dev", "--home-dir", home, "--no-seed", "--port", String(serverPort)],
    {
      T3CODE_PORT_OFFSET: String(Number(webPort) - BASE_WEB_PORT),
      T3CODE_DEV_ALLOWED_ORIGINS: `http://127.0.0.1:${webPort}`,
      // Makes the startup pairing link reusable, so every test can sign in with it.
      T3CODE_DEV_AUTH_TOKEN: NodeCrypto.randomBytes(32).toString("hex"),
    },
  );
  NodeReadline.createInterface({ input: runner.stdout! }).on("line", (line) => {
    const url = /pairingUrl:\s*(\S+)/.exec(line)?.[1];
    if (url === undefined) return void process.stdout.write(`${line}\n`);
    // The link is a credential: it goes to a file the tests read, never to the log.
    const { pathname, search, hash } = new URL(url);
    NodeFS.writeFileSync(NodePath.join(home, "pairing-path"), `${pathname}${search}${hash}`);
  });
} else {
  // The device is another machine: the server listens on every interface, and Metro serves the
  // dev client its JavaScript. Tests mint their own pairing links, so the startup one is dropped.
  const [serverPort, metroPort, host] = ports as [string, string, string];
  const listen = ["--host", "0.0.0.0", "--port", serverPort];
  const server = start(
    process.cwd(),
    process.execPath,
    ["scripts/dev-runner.ts", "dev:server", "--home-dir", home, "--no-seed", ...listen],
    {},
  );
  NodeReadline.createInterface({ input: server.stdout! }).on("line", (line) => {
    if (!line.includes("pairingUrl:")) process.stdout.write(`${line}\n`);
  });
  while (!(await listening(Number(serverPort)))) await NodeTimersPromises.setTimeout(500);
  const metro = start(
    NodePath.join(process.cwd(), "apps/mobile"),
    "npx",
    ["expo", "start", "--dev-client", "--scheme", "t3code-dev", "--lan", "--port", metroPort],
    {
      APP_VARIANT: "development",
      CI: "1",
      // Lazily fetched chunks sometimes arrive broken on pool devices.
      EXPO_NO_METRO_LAZY: "1",
      REACT_NATIVE_PACKAGER_HOSTNAME: host,
    },
  );
  metro.stdout!.pipe(process.stdout);
}
