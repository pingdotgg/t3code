// @effect-diagnostics nodeBuiltinImport:off
// The app command of e2e.config.ts: starts this checkout's dev stack on a fresh T3 home.
// Usage: node start-app.ts <t3-home> <web-port>, run from the checkout whose app should start.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const [home, webPort] = process.argv.slice(2);
if (home === undefined || webPort === undefined) {
  throw new Error("Usage: start-app.ts <t3-home> <web-port>");
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

const serverPort = await new Promise<number>((resolve) => {
  const probe = NodeNet.createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address() as NodeNet.AddressInfo;
    probe.close(() => resolve(port));
  });
});

const child = NodeChildProcess.spawn(
  process.execPath,
  ["scripts/dev-runner.ts", "dev", "--home-dir", home, "--no-seed", "--port", String(serverPort)],
  {
    stdio: ["ignore", "pipe", "inherit"],
    env: {
      ...process.env,
      PATH: `${NodePath.join(home, "bin")}${NodePath.delimiter}${process.env.PATH ?? ""}`,
      T3CODE_PORT_OFFSET: String(Number(webPort) - BASE_WEB_PORT),
      T3CODE_DEV_ALLOWED_ORIGINS: `http://127.0.0.1:${webPort}`,
      T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
      // Makes the startup pairing link reusable, so every test can sign in with it.
      T3CODE_DEV_AUTH_TOKEN: NodeCrypto.randomBytes(32).toString("hex"),
    },
  },
);
NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
  const url = /pairingUrl:\s*(\S+)/.exec(line)?.[1];
  if (url === undefined) return void process.stdout.write(`${line}\n`);
  // The link is a credential: it goes to a file the tests read, never to the log.
  const { pathname, search, hash } = new URL(url);
  NodeFS.writeFileSync(NodePath.join(home, "pairing-path"), `${pathname}${search}${hash}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
