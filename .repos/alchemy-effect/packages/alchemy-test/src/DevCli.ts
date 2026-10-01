import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as path from "node:path";

export type PollOptions = {
  readonly tries?: number;
  readonly delayMs?: number;
};

export const pollUntil = async <T>(
  what: string,
  effect: () => T | undefined | Promise<T | undefined>,
  options: PollOptions & {
    readonly diagnostics?: () => string;
    /**
     * Returns a reason to give up early (e.g. "the process exited"), or
     * `undefined` to keep polling. Checked after every unsuccessful attempt so
     * a dead subject fails in one tick instead of burning the whole budget.
     */
    readonly abandonIf?: () => string | undefined;
  } = {},
): Promise<T> => {
  const { tries = 30, delayMs = 1_000, diagnostics, abandonIf } = options;
  for (let attempt = 0; attempt < tries; attempt++) {
    const value = await effect();
    if (value !== undefined) return value;
    const reason = abandonIf?.();
    if (reason !== undefined) {
      const detail = diagnostics?.();
      throw new Error(
        `Gave up waiting for ${what}: ${reason}.${detail ? `\n${detail}` : ""}`,
      );
    }
    await Bun.sleep(delayMs);
  }
  const detail = diagnostics?.();
  throw new Error(
    `Timed out waiting for ${what}.${detail ? `\n${detail}` : ""}`,
  );
};

export function fetchOk(
  url: string | URL,
  options?: PollOptions,
): Promise<Response>;
export function fetchOk(
  url: string | URL,
  init?: RequestInit,
  options?: PollOptions,
): Promise<Response>;
export async function fetchOk(
  url: string | URL,
  initOrOptions: RequestInit | PollOptions = {},
  explicitOptions?: PollOptions,
): Promise<Response> {
  const optionsOnly =
    explicitOptions === undefined &&
    ("tries" in initOrOptions || "delayMs" in initOrOptions);
  const init = optionsOnly ? undefined : (initOrOptions as RequestInit);
  const options = optionsOnly
    ? (initOrOptions as PollOptions)
    : (explicitOptions ?? {});
  const { tries = 20, delayMs = 500 } = options;
  let last: Response | undefined;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      last = await fetch(url, init);
      if (last.ok) return last;
    } catch {
      // The dev endpoint may not be listening yet.
    }
    await Bun.sleep(delayMs);
  }
  throw new Error(
    `${init?.method ?? "GET"} ${url} never returned 2xx (last status: ${last?.status})`,
  );
}

export type DevCliOptions = {
  readonly root: string;
  readonly stage?: string;
  readonly alchemyBin?: string;
  readonly env?: NodeJS.ProcessEnv;
};

export const parseOutputUrl = (
  output: string,
  key: string,
): string | undefined => {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return output.match(
    new RegExp(
      `\\b${escaped}(?:\\s*:\\s*|\\s+)['"]?(http[^\\s'",]+)['"]?(?=[\\s,}])`,
    ),
  )?.[1];
};

export const parseOutputValue = (
  output: string,
  key: string,
): string | undefined => {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return output.match(
    new RegExp(`\\b${escaped}(?:\\s*:\\s*|\\s+)['"]?([^\\s'",]+)`),
  )?.[1];
};

/** Owns a real `alchemy dev` child and its complete detached process group. */
export class DevCli {
  readonly root: string;
  readonly stage: string;
  readonly alchemyBin: string;
  readonly env: NodeJS.ProcessEnv;
  #process: ReturnType<typeof spawn> | undefined;
  #output = "";

  constructor(options: DevCliOptions) {
    this.root = options.root;
    this.stage = options.stage ?? "dev-cli-test";
    this.alchemyBin =
      options.alchemyBin ??
      path.join(this.root, "node_modules", "alchemy", "bin", "alchemy.ts");
    this.env = { ...process.env, ...options.env };
  }

  get output(): string {
    return this.#output;
  }

  get outputTail(): string {
    return `--- alchemy dev output (tail) ---\n${this.#output.slice(-4_000)}`;
  }

  start(): void {
    if (this.#process !== undefined) throw new Error("alchemy dev is running");
    const child = spawn(
      "bun",
      [this.alchemyBin, "dev", "--stage", this.stage],
      {
        cwd: this.root,
        detached: true,
        env: this.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.#process = child;
    forwardSignals(child);
    const capture = (chunk: Buffer) => {
      const text = chunk.toString();
      this.#output += text;
      if (process.env.DEBUG) process.stderr.write(text);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
  }

  outputUrl(key: string): string | undefined {
    return parseOutputUrl(this.#output, key);
  }

  outputValue(key: string): string | undefined {
    return parseOutputValue(this.#output, key);
  }

  pollUntil<T>(
    what: string,
    effect: () => T | undefined | Promise<T | undefined>,
    options: PollOptions = {},
  ): Promise<T> {
    return pollUntil(what, effect, {
      ...options,
      diagnostics: () => this.outputTail,
      // A dev child that died (crash, failed apply) never produces what we're
      // waiting for — fail immediately with its output instead of sitting
      // through the full poll budget.
      abandonIf: () => {
        const child = this.#process;
        if (child === undefined) return "alchemy dev is not running";
        if (child.exitCode !== null) {
          return `alchemy dev exited with code ${child.exitCode}`;
        }
        if (child.signalCode !== null) {
          return `alchemy dev was killed by ${child.signalCode}`;
        }
        return undefined;
      },
    });
  }

  outputUrlWhenReady(key: string, options?: PollOptions): Promise<string> {
    return this.pollUntil(
      `${key} url in stack outputs`,
      () => this.outputUrl(key),
      options,
    );
  }

  async stop(): Promise<void> {
    const child = this.#process;
    if (child?.pid === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      this.#process = undefined;
      return;
    }
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        // The group has already exited.
      }
    };
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    killGroup("SIGINT");
    await Promise.race([exited, Bun.sleep(15_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      killGroup("SIGKILL");
      await Promise.race([exited, Bun.sleep(5_000)]);
    }
    this.#process = undefined;
  }

  destroy(options: { readonly timeout?: number } = {}): void {
    const result = spawnSync(
      "bun",
      [this.alchemyBin, "destroy", "--stage", this.stage, "--yes"],
      {
        cwd: this.root,
        env: this.env,
        stdio: "inherit",
        timeout: options.timeout ?? 120_000,
      },
    );
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      throw new Error(`alchemy destroy exited ${result.status ?? "by signal"}`);
    }
  }
}

/** Forward Ctrl-C to a detached CLI and let it finish its own cleanup. */
export const forwardSignals = (child: ChildProcess): void => {
  let interrupted: NodeJS.Signals | undefined;
  const forward = (signal: NodeJS.Signals) => {
    if (interrupted !== undefined) return;
    interrupted = signal;
    child.kill(signal);
  };
  const removeListeners = () => {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  child.once("error", removeListeners);
  child.once("exit", () => {
    removeListeners();
    // Bun skips afterAll on Ctrl-C. Exit only after the CLI has shut down,
    // without resuming the interrupted tests or starting the next command.
    if (interrupted !== undefined) {
      process.exit(interrupted === "SIGINT" ? 130 : 143);
    }
  });
};
