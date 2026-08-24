/**
 * Stray-output hardening: while a run is active, every patchable JS-level
 * path that could write to the terminal is diverted into the run log so it
 * can never interleave with reporter output (plain mode) or corrupt the
 * alternate screen (TUI mode). Identified-and-fixed-at-the-source is still
 * preferred (per-test capture attributes output to its test); this is the
 * safety net that makes an unknown writer harmless instead of a corruption
 * hunt.
 *
 * Diverted globally (prefixed in the log; all verified under bun):
 *   1. `process.stdout.write` / `process.stderr.write`  [stray stdout|stderr]
 *   2. global `console.*` — bun's console does NOT go through
 *      `process.stdout.write`, it writes natively             [stray console]
 *   3. `Bun.spawn` with `stdout/stderr: "inherit"` — downgraded to "pipe"
 *      and pumped into the log                                  [stray child]
 *   4. best-effort only: `node:child_process.spawn` inherit and
 *      `fs.writeSync/write` to fds 1/2. Under bun, ESM namespace imports
 *      bind straight to the native functions and IGNORE module-object
 *      mutation, so these patches only cover CJS `require` callers. ESM
 *      users of these APIs must be fixed at the source (e.g.
 *      LanguageModel.test.ts's fs.writeSync(2) was).
 *
 * NOT interceptable from JS at all: native code writing to the fd directly
 * (e.g. rolldown's Rust progress spinner — held off via CI=true / logLevel).
 *
 * The reporter itself writes through {@link writeDirect}, which always uses
 * the REAL stream saved before patching.
 */
// The sinks run inside synchronous patches — they cannot be effectful, so
// this module uses node:fs append directly (append mode interleaves safely
// with the Effect-based FileLog appends).
import * as childProcess from "node:child_process";
import * as fs from "node:fs";

type StreamWrite = typeof process.stdout.write;

let realStdoutWrite: StreamWrite | undefined;

/** Write to the real terminal, bypassing any active stray-output capture. */
export const writeDirect = (text: string): void => {
  const write = realStdoutWrite ?? process.stdout.write.bind(process.stdout);
  write(text);
};

const decoder = new TextDecoder();

// Strip ANSI so diverted output is readable in the log.
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\u001B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

const toText = (chunk: unknown): string =>
  (typeof chunk === "string"
    ? chunk
    : chunk instanceof Uint8Array
      ? decoder.decode(chunk)
      : String(chunk)
  ).replace(ANSI_RE, "");

/**
 * Divert every JS-level terminal writer into `logFile`. Returns a restore
 * function; safe to call multiple times (only the first install wins).
 */
export const captureStrayOutput = (logFile: string): (() => void) => {
  if (realStdoutWrite !== undefined) return () => {};

  const sink = (prefix: string, chunk: unknown): void => {
    try {
      const text = toText(chunk);
      if (text.trim() === "") return;
      const prefixed = text
        .split("\n")
        .map((line) => (line === "" ? line : `[${prefix}] ${line}`))
        .join("\n");
      fs.appendFileSync(
        logFile,
        prefixed.endsWith("\n") ? prefixed : `${prefixed}\n`,
      );
    } catch {
      // Never let log diversion break the writer.
    }
  };

  const restores: Array<() => void> = [];

  // -------------------------------------------------------------------------
  // 1. process.stdout / process.stderr stream writes
  // -------------------------------------------------------------------------
  realStdoutWrite = process.stdout.write.bind(process.stdout);
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  const divertStream =
    (prefix: string): StreamWrite =>
    (
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean => {
      const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
      sink(prefix, chunk);
      callback?.(null);
      return true;
    };
  process.stdout.write = divertStream("stray stdout");
  process.stderr.write = divertStream("stray stderr");
  restores.push(() => {
    process.stdout.write = realStdoutWrite!;
    process.stderr.write = realStderrWrite;
    realStdoutWrite = undefined;
  });

  // -------------------------------------------------------------------------
  // 2. global console — bun's console writes natively, NOT via stdout.write
  // -------------------------------------------------------------------------
  try {
    const methods = [
      "log",
      "info",
      "warn",
      "error",
      "debug",
      "trace",
      "dir",
      "table",
      "group",
      "groupCollapsed",
      "groupEnd",
    ] as const;
    const original = new Map<string, unknown>();
    for (const method of methods) {
      original.set(method, console[method]);
      (console as unknown as Record<string, unknown>)[method] = (
        ...args: Array<unknown>
      ) => {
        sink(
          "stray console",
          args
            .map((arg) =>
              typeof arg === "string" ? arg : Bun.inspect(arg, { depth: 4 }),
            )
            .join(" "),
        );
      };
    }
    restores.push(() => {
      for (const [method, fn] of original) {
        (console as unknown as Record<string, unknown>)[method] = fn;
      }
    });
  } catch {
    // best-effort
  }

  // -------------------------------------------------------------------------
  // 3. fs.writeSync / fs.write to fds 1 and 2 (bypasses the stream objects)
  // -------------------------------------------------------------------------
  try {
    const realWriteSync = fs.writeSync;
    const realWrite = fs.write;
    const fsModule = fs as unknown as Record<string, unknown>;
    fsModule.writeSync = ((
      fd: unknown,
      data: unknown,
      ...rest: Array<unknown>
    ) => {
      if (fd === 1 || fd === 2) {
        sink(`stray fd${fd}`, data);
        return typeof data === "string"
          ? Buffer.byteLength(data)
          : ((data as Uint8Array).byteLength ?? 0);
      }
      return (realWriteSync as (...a: Array<unknown>) => number)(
        fd,
        data,
        ...rest,
      );
    }) as typeof fs.writeSync;
    fsModule.write = ((fd: unknown, data: unknown, ...rest: Array<unknown>) => {
      if (fd === 1 || fd === 2) {
        sink(`stray fd${fd}`, data);
        const callback = rest.findLast((arg) => typeof arg === "function") as
          | ((err: Error | null, written: number, data: unknown) => void)
          | undefined;
        callback?.(null, 0, data);
        return;
      }
      return (realWrite as (...a: Array<unknown>) => unknown)(
        fd,
        data,
        ...rest,
      );
    }) as typeof fs.write;
    restores.push(() => {
      fsModule.writeSync = realWriteSync;
      fsModule.write = realWrite;
    });
  } catch {
    // best-effort — the module namespace may not be writable
  }

  // -------------------------------------------------------------------------
  // 4. child processes spawned with stdio: "inherit" (fd-level, otherwise
  //    unintersectable) — downgrade stdout/stderr to "pipe" and pump.
  // -------------------------------------------------------------------------
  try {
    const realSpawn = childProcess.spawn;
    const cpModule = childProcess as unknown as Record<string, unknown>;
    cpModule.spawn = ((...args: Array<unknown>) => {
      const options = args.find(
        (arg): arg is Record<string, unknown> =>
          typeof arg === "object" && arg !== null && !Array.isArray(arg),
      );
      let pumpStdout = false;
      let pumpStderr = false;
      if (options !== undefined) {
        const stdio = options.stdio;
        if (stdio === "inherit") {
          options.stdio = ["inherit", "pipe", "pipe"];
          pumpStdout = pumpStderr = true;
        } else if (Array.isArray(stdio)) {
          if (stdio[1] === "inherit") {
            stdio[1] = "pipe";
            pumpStdout = true;
          }
          if (stdio[2] === "inherit") {
            stdio[2] = "pipe";
            pumpStderr = true;
          }
        }
      }
      const child = (
        realSpawn as (...a: Array<unknown>) => childProcess.ChildProcess
      )(...args);
      if (pumpStdout) {
        child.stdout?.on("data", (chunk) => sink("stray child", chunk));
      }
      if (pumpStderr) {
        child.stderr?.on("data", (chunk) => sink("stray child", chunk));
      }
      return child;
    }) as typeof childProcess.spawn;
    restores.push(() => {
      cpModule.spawn = realSpawn;
    });
  } catch {
    // best-effort
  }

  try {
    const realBunSpawn = Bun.spawn;
    Bun.spawn = ((...args: Array<unknown>) => {
      // Both signatures: Bun.spawn(cmds, options?) and Bun.spawn({ cmd, ... }).
      const options = args.find(
        (arg): arg is Record<string, unknown> =>
          typeof arg === "object" && arg !== null && !Array.isArray(arg),
      );
      let pumpStdout = false;
      let pumpStderr = false;
      if (options !== undefined) {
        if (options.stdout === "inherit") {
          options.stdout = "pipe";
          pumpStdout = true;
        }
        if (options.stderr === "inherit") {
          options.stderr = "pipe";
          pumpStderr = true;
        }
      }
      const proc = (
        realBunSpawn as (...a: Array<unknown>) => ReturnType<typeof Bun.spawn>
      )(...args);
      const pump = (stream: unknown): void => {
        if (stream instanceof ReadableStream) {
          void (async () => {
            const reader = stream.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              sink("stray child", value);
            }
          })().catch(() => {});
        }
      };
      if (pumpStdout) pump(proc.stdout);
      if (pumpStderr) pump(proc.stderr);
      return proc;
    }) as typeof Bun.spawn;
    restores.push(() => {
      Bun.spawn = realBunSpawn;
    });
  } catch {
    // best-effort
  }

  return () => {
    // Restore in reverse installation order.
    for (const restore of restores.reverse()) {
      try {
        restore();
      } catch {
        // ignore
      }
    }
  };
};
