/**
 * True `alchemy dev` end-to-end for the microvm shell (mirroring
 * examples/aws-ecs/test/dev.test.ts): spawns the REAL CLI and drives the
 * whole cross-cloud stack locally — no cloud credentials, no cloud
 * resources:
 *
 *   - Worker + ShellSession Durable Object → local workerd
 *   - IAM User/AccessKey/Role + STS chain  → floci
 *   - ShellMicrovm image build + MicroVMs  → floci (real Docker containers)
 *
 * The test opens ONE session WebSocket and runs several commands over it,
 * asserting the streamed output renders like a real shell (no exit-status
 * chatter, no blank-line padding) and that all commands hit the SAME
 * MicroVM (state persists across commands — no re-boot per command).
 */
import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
// Spawn the CLI entry directly (not through `bun run` / the cli.js
// launcher) so signals hit the actual CLI process, whose scope teardown
// kills the exec child and the provider sidecars.
const alchemyBin = path.join(
  root,
  "node_modules",
  "alchemy",
  "bin",
  "alchemy.ts",
);
// Isolated stage so this suite never fights a developer's own `alchemy dev`
// session (default stage) over state rows.
const STAGE = "dev-cli-test";

// The whole suite needs docker (floci and the MicroVM containers).
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

let proc: ReturnType<typeof spawn> | undefined;
let ws: WebSocket | undefined;
let output = "";

const pump = (stream: NodeJS.ReadableStream) => {
  stream.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    if (process.env.DEBUG) process.stderr.write(text);
  });
};

/** Bounded poll for a (possibly async) producer to yield a value. */
const pollUntil = async <T>(
  what: string,
  f: () => T | undefined | Promise<T | undefined>,
  { tries = 30, delayMs = 1000 }: { tries?: number; delayMs?: number } = {},
): Promise<T> => {
  for (let i = 0; i < tries; i++) {
    const value = await f();
    if (value !== undefined) return value;
    await Bun.sleep(delayMs);
  }
  throw new Error(
    `Timed out waiting for ${what}.\n--- alchemy dev output (tail) ---\n${output.slice(-4000)}`,
  );
};

/** Extract a stack-output URL the CLI prints on stdout. */
const outputUrl = (key: string) =>
  output.match(new RegExp(`\\b${key}:\\s*['"]?(http[^\\s'",]+)`))?.[1];

/**
 * Send a command over the session socket and collect streamed output until
 * `expected` shows up — the shell renders like a real terminal (no exit
 * trailer to key on).
 */
const run = (socket: WebSocket, command: string, expected: string) =>
  new Promise<string>((resolve, reject) => {
    let out = "";
    const onMessage = (e: MessageEvent) => {
      out += typeof e.data === "string" ? e.data : "";
      if (out.includes(expected)) {
        socket.removeEventListener("message", onMessage);
        clearTimeout(timer);
        resolve(out);
      }
    };
    // The first command waits through the session's MicroVM boot.
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`timeout for '${command}' (got: ${JSON.stringify(out)})`));
    }, 120_000);
    socket.addEventListener("message", onMessage);
    socket.send(command);
  });

afterAll(async () => {
  ws?.close();
  if (proc?.pid) {
    // Ctrl-C semantics: signal the whole PROCESS GROUP (the CLI, its
    // `--watch` exec child, and the provider sidecars).
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-proc!.pid!, signal);
      } catch {
        // group already gone
      }
    };
    const exited = new Promise((resolve) => proc!.once("exit", resolve));
    killGroup("SIGINT");
    await Promise.race([exited, Bun.sleep(15_000)]);
    if (proc.exitCode === null && proc.signalCode === null) {
      killGroup("SIGKILL");
      await Promise.race([exited, Bun.sleep(5_000)]);
    }
  }
  if (!process.env.NO_DESTROY && dockerAvailable) {
    spawnSync("bun", [alchemyBin, "destroy", "--stage", STAGE, "--yes"], {
      cwd: root,
      stdio: "inherit",
      timeout: 300_000,
    });
    // Session MicroVMs are provisioned at RUNTIME (per WebSocket), not as
    // stack resources, so `destroy` does not reap them — remove the
    // emulator's VM containers this run booted.
    const ids = spawnSync(
      "docker",
      ["ps", "-q", "--filter", "name=floci-microvm-"],
      { encoding: "utf8" },
    )
      .stdout.trim()
      .split("\n")
      .filter(Boolean);
    if (ids.length > 0) {
      spawnSync("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
    }
  }
}, 400_000);

test.skipIf(!dockerAvailable)(
  "alchemy dev serves a browser shell backed by a local MicroVM",
  async () => {
    proc = spawn("bun", [alchemyBin, "dev", "--stage", STAGE], {
      cwd: root,
      // Own process group, so teardown can deliver Ctrl-C to the whole
      // tree the way a terminal would.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    pump(proc.stdout!);
    pump(proc.stderr!);

    // First dev deploy builds the ShellMicrovm image before printing
    // stack outputs.
    const url = await pollUntil("url in stack outputs", () => outputUrl("url"), {
      tries: 600,
      delayMs: 1000,
    });

    // Dev identity: the Worker is local workerd; no real cloud.
    expect(url).toContain("localhost");
    expect(output).not.toContain("apply failed");

    // The Worker serves the terminal SPA.
    const html = await fetch(url).then((r) => r.text());
    expect(html).toContain("microvm@shell");

    // One session socket: the Worker provisions the session's MicroVM
    // (assume-role control plane against floci) and hands it to the DO.
    const wsUrl = new URL(url);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.pathname = `/session/dev-test-${Math.random().toString(36).slice(2, 8)}/ws`;
    const socket = new WebSocket(wsUrl);
    ws = socket;
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("socket error")));
    });

    // Command round-trip, streamed back through DO → Worker → browser.
    const marker = "hello-from-microvm";
    const first = await run(socket, `echo ${marker}`, marker);
    expect(first).toContain(`${marker}\n`);

    // Real-shell rendering: no exit-status chatter, no blank-line padding.
    expect(first).not.toContain("[exit");
    expect(first).not.toMatch(/\n\n/);

    // Two more commands on the SAME socket → same cached VM: a file written
    // by one command is read back by the next (state persists, no re-boot).
    await run(socket, "echo persisted-$$ > /tmp/marker.txt && echo written", "written");
    const readBack = await run(socket, "cat /tmp/marker.txt", "persisted-");
    expect(readBack).toMatch(/persisted-\d+\n/);
    expect(readBack).not.toMatch(/\n\n/);
  },
  600_000,
);
