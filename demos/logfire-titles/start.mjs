import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";

const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher runs before the server's Effect runtime exists.
const windows = process.platform === "win32";
NodeFS.mkdirSync(NodePath.join(root, ".t3"), { recursive: true });
const child = NodeChildProcess.spawn(
  "node",
  [
    "scripts/dev-runner.ts",
    "dev",
    "--home-dir",
    NodePath.join(root, ".t3"),
    ...process.argv.slice(2),
  ],
  {
    cwd: root,
    detached: !windows,
    stdio: ["inherit", "pipe", "inherit"],
    env: {
      ...process.env,
      T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
      T3CODE_LOGFIRE_TITLE_CORPUS: NodePath.join(root, "demos/logfire-titles/corpus.json"),
      T3CODE_LOGFIRE_TITLE_PROMPT: NodePath.join(root, "demos/logfire-titles/title-prompt.txt"),
    },
  },
);
let pending = "";
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  pending += chunk.toString();
  const lines = pending.split("\n");
  pending = lines.pop();
  for (const line of lines) {
    const ports = line.match(/serverPort=(\d+) webPort=(\d+)/);
    if (ports)
      NodeFS.writeFileSync(
        NodePath.join(root, ".t3/title-demo.json"),
        JSON.stringify({
          origin: `http://localhost:${ports[1]}`,
          webOrigin: `http://localhost:${ports[2]}`,
        }),
      );
  }
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (windows) child.kill(signal);
    else if (child.pid) process.kill(-child.pid, signal);
  });
child.on("exit", (code) => (process.exitCode = code ?? 1));
