/**
 * Scaffolding for the `alchemy dev` stress suite.
 *
 * Everything here exists to make one thing possible: run the REAL CLI
 * against a throwaway copy of this project and then rewrite that copy's
 * files underneath it, while keeping every assertion independent of what
 * the CLI happens to be printing at the time.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** The checked-in example project (the copy source). */
export const EXAMPLE_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Spawn the CLI entry directly rather than through `bun run` / `cli.js`, so
 * signals reach the actual CLI process whose scope teardown kills the exec
 * child and the provider sidecars.
 */
export const ALCHEMY_BIN = path.join(
  EXAMPLE_ROOT,
  "node_modules",
  "alchemy",
  "bin",
  "alchemy.ts",
);

/** Entries never copied into a scratch project. */
const SKIP_COPY = new Set([
  "node_modules",
  "test",
  ".stress",
  ".alchemy",
  "dist",
  "tsconfig.json",
  "bun.lock",
]);

/**
 * Copy the checked-in project into `.stress/<name>/`.
 *
 * The scratch dir lives INSIDE the example so Node/Bun resolution still
 * walks up into `examples/dev-stress/node_modules` and finds the workspace
 * `alchemy` link — while every mutation the suite makes stays out of the
 * source-controlled tree, and survives a mid-suite failure without leaving
 * the repo dirty.
 */
/**
 * Reset the floci emulator to a clean slate before a run. A KILLED previous
 * run (bun's timeout, Ctrl-C on the test process) never reaches the CLI's
 * graceful shutdown, so its emulated ECS services stay registered in the
 * long-lived `alchemy-floci` container — their reconcilers re-spawn task
 * containers forever and squat the suite's pinned host ports, deadlocking
 * every subsequent run. The emulator is disposable by design (in-memory
 * state, local image), so a fresh one per run makes the suite self-healing
 * regardless of how the previous run died.
 */
export const resetFlociEmulator = (): void => {
  const names = spawnSync(
    "docker",
    ["ps", "-aq", "--filter", "name=^(alchemy-floci$|floci-ec2|floci-ecs|floci-microvm)"],
    { encoding: "utf8", timeout: 30_000 },
  )
    .stdout?.trim()
    .split("\n")
    .filter(Boolean);
  if (names && names.length > 0) {
    spawnSync("docker", ["rm", "-f", ...names], {
      stdio: "ignore",
      timeout: 120_000,
    });
  }
};

/**
 * Free the suite's pinned ports before a run. A KILLED previous run leaves
 * orphaned workerd / dev-child processes listening on them (they are not
 * children of the test process, so bun's cleanup never reaches them), and
 * every `strictPort` worker then fails its first apply. Scoped strictly to
 * the ports this suite owns.
 */
export const freePinnedPorts = (ports: readonly number[]): void => {
  const pids = new Set<string>();
  for (const port of ports) {
    const out = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 15_000,
    }).stdout;
    for (const pid of (out ?? "").trim().split("\n")) {
      if (pid) pids.add(pid);
    }
  }
  if (pids.size === 0) return;
  spawnSync("kill", [...pids], { stdio: "ignore", timeout: 15_000 });
  // Grace, then force anything still holding a port.
  spawnSync("sleep", ["2"], { stdio: "ignore", timeout: 5_000 });
  spawnSync("kill", ["-9", ...pids], { stdio: "ignore", timeout: 15_000 });
};

export const makeScratchProject = (name: string): string => {
  const dir = path.join(EXAMPLE_ROOT, ".stress", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(EXAMPLE_ROOT)) {
    if (SKIP_COPY.has(entry) || entry.startsWith(".git")) continue;
    fs.cpSync(path.join(EXAMPLE_ROOT, entry), path.join(dir, entry), {
      recursive: true,
    });
  }
  return dir;
};

export interface DevServerOptions {
  /** Scratch project directory the CLI runs in. */
  readonly cwd: string;
  /** Stage name — isolates local state from any other run. */
  readonly stage: string;
  /** Extra environment for the CLI process. */
  readonly env?: Record<string, string>;
}

/**
 * Hermetic environment for the CLI: an alchemy profile that exists nowhere
 * on disk plus stripped AWS credentials, so the run can only resolve to the
 * local emulator, and placeholder Cloudflare credentials so the local
 * Cloudflare providers' env lookups are satisfied without any cloud call
 * being possible.
 *
 * `CI=1` is what makes the placeholders usable: without it a profile with
 * no configured Cloudflare section refuses to fall back to environment
 * credentials in a non-interactive process.
 */
export const hermeticEnv = (extra?: Record<string, string>) => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "1",
    ALCHEMY_PROFILE: "dev-stress-cli-test",
    CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    CLOUDFLARE_API_TOKEN: "dev-stress-placeholder",
    ...extra,
  };
  delete env.AWS_ACCESS_KEY_ID;
  delete env.AWS_SECRET_ACCESS_KEY;
  delete env.AWS_SESSION_TOKEN;
  delete env.AWS_PROFILE;
  return env;
};

export class DevServer {
  readonly proc: ChildProcess;
  readonly cwd: string;
  readonly stage: string;
  /** Everything the CLI has written to stdout+stderr, in order. */
  output = "";
  private readonly logPath: string;
  private readonly logStream: fs.WriteStream;

  constructor(options: DevServerOptions) {
    this.cwd = options.cwd;
    this.stage = options.stage;
    this.logPath = path.join(options.cwd, "dev-stress.log");
    this.logStream = fs.createWriteStream(this.logPath, { flags: "a" });
    this.proc = spawn(
      "bun",
      [ALCHEMY_BIN, "dev", "--stage", options.stage],
      {
        cwd: options.cwd,
        // Own process group so teardown can deliver Ctrl-C to the whole
        // tree (CLI + `--watch` exec child + provider sidecars) the way a
        // terminal would.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: hermeticEnv(options.env),
      },
    );
    const pump = (stream: NodeJS.ReadableStream | null) =>
      stream?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        this.output += text;
        this.logStream.write(text);
        if (process.env.DEBUG) process.stderr.write(text);
      });
    pump(this.proc.stdout);
    pump(this.proc.stderr);
  }

  /** `true` while the CLI process itself is still running. */
  get alive(): boolean {
    return this.proc.exitCode === null && this.proc.signalCode === null;
  }

  /** A cursor into {@link output}, for "did anything new happen since?". */
  mark(): number {
    return this.output.length;
  }

  /** Output written since `cursor`. */
  since(cursor: number): string {
    return this.output.slice(cursor);
  }

  /** Last `n` characters of output — for failure messages. */
  tail(n = 6_000): string {
    return this.output.slice(-n);
  }

  /**
   * Number of plan renders. `alchemy dev` prints one `Plan:` line per run
   * of the stack, so this counts EXEC-CHILD RESTARTS.
   *
   * It is the discriminator between the two dev reload paths. Both paths
   * put new code in front of a request within a couple of seconds — the
   * local Worker provider's bundler watch loop always wins the race — but
   * only a file inside the STACK's import graph also makes `bun --watch`
   * re-run the stack, which shows up here a beat later. Measured on this
   * fixture: a bundler-only edit swaps at ~2s and never re-plans; a
   * stack-graph edit swaps at ~2s and re-plans at ~4s.
   */
  get planCount(): number {
    return this.output.match(/^Plan:/gm)?.length ?? 0;
  }

  /** Number of applies that ran to completion (`Done: N succeeded`). */
  get doneCount(): number {
    return this.output.match(/^Done:/gm)?.length ?? 0;
  }

  /**
   * Resolve once the CLI has rendered more than `count` plans — i.e. the
   * stack has re-run. The re-plan trails the bundler's hot swap, so this
   * must be WAITED for, never sampled right after new code starts serving.
   */
  waitForPlanAfter(count: number, options?: { tries?: number }): Promise<true> {
    return pollUntil(
      `the stack to re-run (plan #${count + 1})`,
      () => (this.planCount > count ? (true as const) : undefined),
      { tries: options?.tries ?? 120, delayMs: 500, server: this },
    );
  }

  /**
   * Resolve once no new plan has appeared for `quietMs`. Phases that edit
   * a file inside the STACK's import graph leave a re-plan trailing the
   * hot swap by a few seconds; a later phase that baselines `planCount`
   * (to assert "this path never re-plans") must absorb that trail first
   * or the trailing plan lands inside its window and reads as a spurious
   * re-run.
   */
  async settlePlans(quietMs = 8_000, capMs = 60_000): Promise<void> {
    const deadline = Date.now() + capMs;
    let last = this.planCount;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      await Bun.sleep(500);
      const current = this.planCount;
      if (current !== last) {
        last = current;
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= quietMs) {
        return;
      }
    }
  }

  /**
   * Throws (with an output tail) unless the CLI process is still running.
   * The single most important invariant of the whole suite: nothing the
   * suite does to the project may kill the dev server.
   */
  assertAlive(context: string): void {
    if (this.alive) return;
    throw new Error(
      `alchemy dev died during: ${context}\n` +
        `exit=${this.proc.exitCode} signal=${this.proc.signalCode}\n` +
        `--- output tail ---\n${this.tail()}`,
    );
  }

  /**
   * What the CLI has printed since `cursor`, with ANSI colour stripped —
   * `bun test` output is not a TTY, but the exec child still colours its
   * plan lines when stdout is a pipe it believes supports colour.
   */
  plain(cursor = 0): string {
    // eslint-disable-next-line no-control-regex
    return this.output.slice(cursor).replaceAll(/\x1b\[[0-9;]*m/g, "");
  }

  /** Extract a plain value for `key` from the stack outputs the CLI printed. */
  outputValue(key: string): string | undefined {
    const matches = this.output.match(
      new RegExp(`${key}:\\s*['\"]?([^\\s'\",]+)`, "g"),
    );
    // The newest print wins: outputs are re-printed on every re-apply.
    return matches
      ?.at(-1)
      ?.match(new RegExp(`${key}:\\s*['\"]?([^\\s'\",]+)`))?.[1];
  }

  /** Extract a URL for `key` from the stack outputs the CLI printed. */
  outputUrl(key: string): string | undefined {
    const matches = this.output.match(
      new RegExp(`${key}:\\s*['"]?(http[^\\s'",]+)`, "g"),
    );
    // The newest print wins: outputs are re-printed on every re-apply.
    return matches?.at(-1)?.match(/(http[^\s'",]+)/)?.[1];
  }

  // ── file mutation ────────────────────────────────────────────────────

  abs(relative: string): string {
    return path.join(this.cwd, relative);
  }

  read(relative: string): string {
    return fs.readFileSync(this.abs(relative), "utf8");
  }

  write(relative: string, contents: string): void {
    const file = this.abs(relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }

  remove(relative: string): void {
    fs.rmSync(this.abs(relative), { force: true, recursive: true });
  }

  move(from: string, to: string): void {
    const target = this.abs(to);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(this.abs(from), target);
  }

  exists(relative: string): boolean {
    return fs.existsSync(this.abs(relative));
  }

  /**
   * Replace the body of a `// <<NAME>> … // <</NAME>>` region. Surgical
   * region edits keep the rest of the stack byte-identical, so a diff the
   * suite makes is exactly the change under test — no regex drift.
   */
  patchRegion(relative: string, name: string, body: string): void {
    const source = this.read(relative);
    const pattern = new RegExp(
      `([ \\t]*// <<${name}>>\\n)[\\s\\S]*?([ \\t]*// <<\\/${name}>>)`,
    );
    if (!pattern.test(source)) {
      throw new Error(`region <<${name}>> not found in ${relative}`);
    }
    this.write(relative, source.replace(pattern, `$1${body}$2`));
  }

  // ── teardown ─────────────────────────────────────────────────────────

  /**
   * Ctrl-C the whole process GROUP, then escalate. Signalling only the CLI
   * orphans the exec child, which keeps holding the stack's state lock.
   */
  async shutdown(timeoutMs = 30_000): Promise<void> {
    if (!this.proc.pid) return;
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-this.proc.pid!, signal);
      } catch {
        // group already gone
      }
    };
    const exited = new Promise((resolve) => this.proc.once("exit", resolve));
    killGroup("SIGINT");
    await Promise.race([exited, Bun.sleep(timeoutMs)]);
    if (this.alive) {
      killGroup("SIGKILL");
      await Promise.race([exited, Bun.sleep(5_000)]);
    }
    this.logStream.end();
  }

  /** Tear the stack's local resources down out of band. */
  destroyStack(timeoutMs = 180_000): void {
    spawnSync(
      "bun",
      [ALCHEMY_BIN, "destroy", "--stage", this.stage, "--yes"],
      {
        cwd: this.cwd,
        stdio: process.env.DEBUG ? "inherit" : "ignore",
        timeout: timeoutMs,
        env: hermeticEnv(),
      },
    );
  }
}

// ── polling helpers ─────────────────────────────────────────────────────

export class PollTimeout extends Error {}

/**
 * Every request the suite makes carries a deadline. A local Worker that is
 * hot-swapped while a request is in flight can drop that request on the
 * floor — workerd cancels it and the dev proxy never answers the client —
 * and a bare `fetch` would then wait forever, wedging the whole suite
 * (observed: a `/roundtrip` in flight across a MicrovmWorker bundle swap).
 * The deadline is generous enough for a MicroVM boot-to-terminate
 * roundtrip, which is the slowest single request here.
 */
export const REQUEST_TIMEOUT_MS = 120_000;

export const fetchWithDeadline = (
  url: string | URL,
  init?: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> =>
  fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });

/** Bounded poll for a (possibly async) producer to yield a value. */
export const pollUntil = async <T>(
  what: string,
  f: () => T | undefined | Promise<T | undefined>,
  {
    tries = 60,
    delayMs = 500,
    server,
  }: { tries?: number; delayMs?: number; server?: DevServer } = {},
): Promise<T> => {
  for (let i = 0; i < tries; i++) {
    // A dead CLI can never satisfy the predicate — fail immediately with
    // the crash context instead of burning the whole budget.
    server?.assertAlive(what);
    const value = await f();
    if (value !== undefined) return value;
    await Bun.sleep(delayMs);
  }
  throw new PollTimeout(
    `Timed out after ${(tries * delayMs) / 1000}s waiting for ${what}.` +
      (server ? `\n--- alchemy dev output (tail) ---\n${server.tail()}` : ""),
  );
};

/** Fetch with retries — a freshly (re)started worker takes a moment. */
export const fetchOk = async (
  url: string | URL,
  init?: RequestInit,
  { tries = 40, delayMs = 500 }: { tries?: number; delayMs?: number } = {},
): Promise<Response> => {
  let last: Response | undefined;
  let error: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      last = await fetchWithDeadline(url, init);
      if (last.ok) return last;
    } catch (cause) {
      error = cause; // not listening yet, mid-swap, or dropped
    }
    await Bun.sleep(delayMs);
  }
  throw new Error(
    `${init?.method ?? "GET"} ${url} never returned 2xx ` +
      `(last status: ${last?.status}, last error: ${String(error)})`,
  );
};

export const fetchJson = async <T>(
  url: string | URL,
  init?: RequestInit,
  options?: { tries?: number; delayMs?: number },
): Promise<T> => (await fetchOk(url, init, options)).json() as Promise<T>;

/**
 * Poll a URL until its JSON body satisfies `predicate`. This is how the
 * suite observes a reload landing: not by reading the CLI's logs, but by
 * asking the running worker what code it is currently executing.
 */
export const waitForJson = async <T>(
  what: string,
  url: string | URL,
  predicate: (body: T) => boolean,
  options?: { tries?: number; delayMs?: number; server?: DevServer },
): Promise<T> => {
  // What the endpoint last said, so a timeout explains itself: "served the
  // OLD marker for 240s" and "answered 502 the whole time" are different
  // bugs, and a bare timeout hides which one it was.
  let last = "no response yet";
  try {
    return await pollUntil(
      what,
      async () => {
        try {
          const res = await fetchWithDeadline(url);
          const text = await res.text();
          last = `${res.status} ${text.slice(0, 300)}`;
          if (!res.ok) return undefined;
          const body = JSON.parse(text) as T;
          return predicate(body) ? body : undefined;
        } catch (cause) {
          last = `error: ${String(cause).slice(0, 300)}`;
          return undefined; // mid-restart, or dropped
        }
      },
      { tries: 120, delayMs: 500, ...options },
    );
  } catch (cause) {
    if (cause instanceof PollTimeout) {
      cause.message = `${cause.message.split("\n")[0]}\n--- last response from ${url} ---\n${last}\n${cause.message.split("\n").slice(1).join("\n")}`;
    }
    throw cause;
  }
};

/** `http://localhost:<port>` */
export const at = (port: number, path = "/"): URL =>
  new URL(path, `http://localhost:${port}`);

/** Docker gate — floci (the AWS emulator) and Containers both need it. */
export const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 30_000 })
    .status === 0;
