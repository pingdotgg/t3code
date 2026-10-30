// @effect-diagnostics nodeBuiltinImport:off - shared setup for the stress rig's CLIs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const repo = NodePath.resolve(import.meta.dirname, "../../..");
export const webDir = NodePath.join(repo, "apps/web");
const serverBin = NodePath.join(repo, "apps/server/src/bin.ts");
const replayAgent = NodePath.join(repo, "apps/server/scripts/dev-replay-agent.ts");

/** Recorded pull requests outlive any one checkout, so every worktree shares them. */
export const fixturesDir = NodePath.join(
  process.env.XDG_CACHE_HOME ?? NodePath.join(NodeOS.homedir(), ".cache"),
  "t3code-stress/fixtures",
);

export const log = (message: string) => console.error(`[stress] ${message}`);

export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });

export const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  NodeChildProcess.execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });

/** Runs the `t3` CLI from source against `home`. */
export const t3 = (home: string, ...args: string[]) =>
  run(process.execPath, [serverBin, ...args, "--base-dir", home], repo);

/**
 * A fresh T3 home with the Replay provider and one git workspace. `remote` names the workspace's
 * origin, which decides the repository its pull requests come from.
 */
export function prepareHome(home: string, remote?: string): string {
  NodeFS.rmSync(home, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
  // The entry `vp run dev` seeds, written up front because this server runs without a dev URL.
  NodeFS.writeFileSync(
    NodePath.join(home, "userdata/settings.json"),
    JSON.stringify({
      // Replay turns ask before they edit; supervised threads stop there until someone answers.
      defaultRuntimeMode: "approval-required",
      providerInstances: {
        devReplay: {
          driver: "acpRegistry",
          displayName: "Replay (dev)",
          config: { source: "local", commandPath: process.execPath, commandArgs: [replayAgent] },
        },
      },
    }),
  );
  const workspace = NodePath.join(home, "workspace");
  NodeFS.mkdirSync(workspace, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(workspace, "README.md"), "# Stress workspace\n");
  run("git", ["init", "-q"], workspace);
  run("git", ["add", "."], workspace);
  run(
    "git",
    ["-c", "user.name=stress", "-c", "user.email=stress@example.com", "commit", "-qm", "init"],
    workspace,
  );
  if (remote) run("git", ["remote", "add", "origin", remote], workspace);
  return workspace;
}

/** Starts `t3 serve` on `home`, logging to `logFile`, and resolves with its pairing URL. */
export async function startServer(input: {
  readonly home: string;
  readonly port: number;
  readonly logFile: string;
  readonly env?: Readonly<Record<string, string>>;
}) {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [serverBin, "serve", "--base-dir", input.home, "--port", String(input.port), "--no-browser"],
    {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "production", ...input.env },
    },
  );
  const serverLog = NodeFS.createWriteStream(input.logFile);
  child.stdout.pipe(serverLog);
  child.stderr.pipe(serverLog);
  const pairingUrl = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const match = /Pairing URL: (\S+)/.exec(buffered);
      if (match) resolve(match[1]!);
    });
    child.once("exit", (code) =>
      reject(new Error(`server exited with ${code}; see ${input.logFile}`)),
    );
  });
  const stop = () => {
    if (child.exitCode === null) child.kill("SIGTERM");
  };
  process.once("exit", stop);
  return { pairingUrl, stop };
}

/** `owner/name#123` or a pull request URL. */
export function parsePullRequest(value: string) {
  const match =
    /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(value) ??
    /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(value);
  if (!match) throw new Error(`Expected owner/name#number or a pull request URL, got ${value}`);
  return { repository: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}

export interface RecordedChange {
  readonly baseSha: string;
  readonly headSha: string;
  readonly title: string;
}

export const changeFile = (repository: string, number: number) =>
  NodePath.join(fixturesDir, "changes", `${repository.replace("/", "__")}__${number}.json`);
