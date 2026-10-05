import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as NodeChildProcess from "node:child_process";
import { ConfigError, SystemError } from "../RuntimeError.shared.ts";
import type { Config } from "./Config.ts";
import { serializeConfig } from "./internal/config.serialize.ts";
import * as workerd from "./internal/workerd.ts";

export interface WorkerdPorts {
  [socket: string]: number;
}

/**
 * Receives a decoded chunk of the workerd process's output along with the
 * stream it was written to.
 */
export type OutputSink = (chunk: string, stream: "stdout" | "stderr") => void;

/** How a workerd process ended after it had finished starting. */
export interface WorkerdExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The last output workerd wrote to stderr before it exited. */
  readonly stderr: string;
}

export interface ServeOptions {
  /**
   * Capture the workerd process's output instead of piping it to the parent
   * process's stdout/stderr. Output produced before the process finishes
   * starting is not captured; startup failures surface as typed errors
   * instead.
   */
  readonly onOutput?: OutputSink;
  /**
   * Called once when the process exits after it finished starting, for
   * example when V8 aborts on heap exhaustion. Not called when the scope
   * closes and the process is killed on purpose.
   */
  readonly onExit?: (exit: WorkerdExit) => void;
}

/** How much trailing stderr output is kept for {@link WorkerdExit}. */
const STDERR_TAIL_BYTES = 4096;

const makeTail = () => {
  let text = "";
  return {
    push: (chunk: string) => {
      text = (text + chunk).slice(-STDERR_TAIL_BYTES);
    },
    read: () => text.trim(),
  };
};

export class Workerd extends Context.Service<
  Workerd,
  {
    readonly compatibilityDate: string;
    readonly serve: (
      config: Config,
      args?: Record<string, string | number | boolean>,
      options?: ServeOptions,
    ) => Effect.Effect<WorkerdPorts, ConfigError | SystemError, Scope.Scope>;
  }
>()("cloudflare-runtime/workerd/Workerd") {}

type ControlMessage =
  | {
      event: "listen";
      socket: string;
      port: number;
    }
  | {
      event: "listen-inspector";
      port: number;
    };

interface ProcessHandle {
  /** Writes the config to the process's stdin. This can be omitted if the config is passed as an argument to the process. */
  readonly configure?: () => Effect.Effect<void, SystemError>;
  /** Waits for the process to listen on the given number of sockets. */
  readonly control: (
    count: number,
  ) => Effect.Effect<Array<ControlMessage>, SystemError>;
  /** Resumes with an error if the process fails to start. */
  readonly error: () => Effect.Effect<never, ConfigError | SystemError>;
  /** Resolves once the process has exited, with the tail of its stderr. */
  readonly exited: () => Effect.Effect<WorkerdExit>;
  /**
   * Pipes the process's stdout/stderr to the console, or to `sink` when one
   * is provided. Called after initialization is complete.
   */
  readonly pipe: (sink?: OutputSink) => Effect.Effect<void, never, Scope.Scope>;
  /** Kills the process. */
  readonly kill: () => void;
}

/**
 * Environment variable holding extra V8 flags for every workerd process this
 * package spawns, separated by whitespace. workerd runs V8 with its default
 * heap limit (about 1.4 GB), which a large application's dev module graph
 * can exhaust after a few hours of edits. `ALCHEMY_WORKERD_V8_FLAGS=--max-old-space-size=4096`
 * raises that limit. Flags from the config come last, so they win when V8
 * sees the same flag twice.
 */
export const V8_FLAGS_ENV = "ALCHEMY_WORKERD_V8_FLAGS";

/** Splits the value of {@link V8_FLAGS_ENV} into individual flags. */
export const parseV8Flags = (value: string | undefined): Array<string> =>
  (value ?? "").split(/\s+/).filter((flag) => flag.length > 0);

const withV8Flags = (config: Config, flags: Array<string>): Config =>
  flags.length === 0
    ? config
    : { ...config, v8Flags: [...flags, ...(config.v8Flags ?? [])] };

const make = (
  spawn: (
    command: string,
    args: Array<string>,
    config: Buffer,
    configuredAddresses: Array<string>,
  ) => Effect.Effect<ProcessHandle, ConfigError | SystemError>,
) =>
  Workerd.of({
    compatibilityDate: workerd.compatibilityDate,
    serve: Effect.fn("Workerd.serve")(
      function* (serveConfig, args, options) {
        const config = withV8Flags(
          serveConfig,
          parseV8Flags(process.env[V8_FLAGS_ENV]),
        );
        // Debug facility: dump each serve's full workerd config as JSON.
        // `WORKERD_DUMP_CONFIG=<dir>` writes one timestamped file per serve.
        const dumpDir = process.env.WORKERD_DUMP_CONFIG;
        if (dumpDir) {
          yield* Effect.promise(async () => {
            const fs = await import("node:fs/promises");
            const path = await import("node:path");
            await fs.mkdir(dumpDir, { recursive: true });
            await fs.writeFile(
              path.join(dumpDir, `workerd-config-${Date.now()}.json`),
              JSON.stringify(config, null, 2),
            );
          });
        }
        const socketOverride = args?.["socket-addr"];
        const override =
          typeof socketOverride === "string" ? socketOverride.indexOf("=") : -1;
        const configuredAddresses = (config.sockets ?? []).flatMap((socket) => {
          const address =
            typeof socketOverride === "string" &&
            override >= 0 &&
            socketOverride.slice(0, override) === socket.name
              ? socketOverride.slice(override + 1)
              : socket.address;
          return address ? [address] : [];
        });
        for (const key of ["debug-port", "inspector-addr"]) {
          const address = args?.[key];
          if (typeof address === "string" || typeof address === "number") {
            configuredAddresses.push(String(address));
          }
        }
        const handle = yield* spawn(
          workerd.bin,
          [
            "serve",
            "--binary",
            "--experimental",
            "--control-fd=3",
            ...Object.entries(args ?? {}).map(([key, value]) =>
              typeof value === "boolean" ? `--${key}` : `--${key}=${value}`,
            ),
            "-",
          ],
          Buffer.from(serializeConfig(config)),
          configuredAddresses,
        );
        let killed = false;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            killed = true;
            handle.kill();
          }),
        );
        if (handle.configure) {
          yield* handle.configure();
        }
        const count =
          (config.sockets?.length ?? 0) +
          (typeof args?.["debug-port"] !== "undefined" ? 1 : 0) +
          (typeof args?.["inspector-addr"] !== "undefined" ? 1 : 0);
        const control = yield* Effect.raceAllFirst([
          handle.control(count),
          handle.error(),
        ]);
        yield* handle.pipe(options?.onOutput);
        const onExit = options?.onExit;
        if (onExit) {
          // The scope's finalizers run in reverse order, so this fiber is
          // interrupted before the kill finalizer above runs; `killed` also
          // covers an exit that lands while the scope is closing.
          yield* handle.exited().pipe(
            Effect.map((exit) => {
              if (!killed) onExit(exit);
            }),
            Effect.forkScoped,
          );
        }
        const ports: WorkerdPorts = {};
        for (const message of control) {
          if (message.event === "listen") {
            ports[message.socket] = message.port;
          }
        }
        return ports;
      },
      Effect.retry({
        while: (error) => error._tag === "SystemError",
        schedule: Schedule.exponential(50),
        times: 3,
      }),
    ),
  });

/**
 * A single consumer per child stream, started at spawn. A web
 * `ReadableStream` can only be locked once — previously `error()` (raced
 * against `control()` during startup) locked stderr, and `pipe()`'s later
 * `pipeTo` silently failed, swallowing ALL worker console output under Bun.
 * The pump buffers chunks until forwarding is enabled, then streams them
 * through; `done` resolves with the full accumulated text at stream end
 * (process death) for error classification.
 */
const makeStreamPump = (
  // Bun and lib.dom disagree on the byte-stream element type
  // (`Uint8Array<ArrayBuffer>` vs `BufferSource`); the pump only ever pipes
  // through a TextDecoderStream, so accept either.
  stream: ReadableStream<any>,
  sink: (chunk: string) => void,
) => {
  const chunks: Array<string> = [];
  const tail = makeTail();
  let target = sink;
  let forwarded = 0;
  let forwarding = false;
  const done = (async () => {
    try {
      for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
        chunks.push(chunk);
        tail.push(chunk);
        if (forwarding) {
          target(chunk);
          forwarded = chunks.length;
        }
      }
    } catch {
      // Stream closed/aborted with the process — the buffer is complete.
    }
    return chunks.join("");
  })();
  return {
    done,
    /** The most recent output, for reporting an unexpected exit. */
    tail: tail.read,
    /** Start forwarding, optionally redirecting to a capture sink. */
    forward: (override?: (chunk: string) => void) => {
      if (override) target = override;
      forwarding = true;
      while (forwarded < chunks.length) {
        target(chunks[forwarded++]);
      }
    },
  };
};

const externalEnv = () => {
  const env = { ...process.env };
  delete env.NODE_ENV;
  return env;
};

const makeBun = () =>
  make((command, args, config, configuredAddresses) =>
    Effect.sync(() =>
      Bun.spawn({
        cmd: [command, ...args],
        env: externalEnv(),
        stdio: [config, "pipe", "pipe", "pipe"],
        killSignal: "SIGKILL",
      }),
    ).pipe(
      Effect.map((child) => {
        const stdout = makeStreamPump(child.stdout, (chunk) => {
          process.stdout.write(chunk);
        });
        const stderr = makeStreamPump(child.stderr, (chunk) => {
          process.stderr.write(chunk);
        });
        return {
          control: (count) =>
            Effect.callback<Array<ControlMessage>, SystemError>(
              (resume, signal) => {
                if (!child.stdio[3]) {
                  return resume(
                    new SystemError({
                      subtag: "WorkerdSpawn",
                      message: "The workerd process did not have a control fd.",
                    }),
                  );
                }
                const file = Bun.file(child.stdio[3]);
                const collect = async () => {
                  let lines = "";
                  for await (const chunk of file
                    .stream()
                    .pipeThrough(new TextDecoderStream(), {
                      signal,
                    })) {
                    lines += chunk;
                    const messages = lines
                      .split("\n")
                      .filter((line) => line.trim() !== "")
                      .map((line) => JSON.parse(line) as ControlMessage);
                    if (messages.length === count) {
                      return resume(Effect.succeed(messages));
                    }
                  }
                };
                // Ignore errors here and let the error callback handle it instead.
                // Errors here are a symptom; the error callback reports the actual cause.
                void collect().catch(() => null);
              },
            ),
          error: () =>
            Effect.callback<never, ConfigError | SystemError>((resume) => {
              void stderr.done.then(async (text) => {
                await child.exited.catch(() => null);
                resume(
                  classifyWorkerdError(
                    text,
                    child.exitCode,
                    child.signalCode,
                    configuredAddresses,
                  ),
                );
              });
            }),
          pipe: (sink) =>
            Effect.sync(() => {
              stdout.forward(sink && ((chunk) => sink(chunk, "stdout")));
              stderr.forward(sink && ((chunk) => sink(chunk, "stderr")));
            }),
          exited: () =>
            Effect.promise(async () => {
              await child.exited.catch(() => null);
              // The pipes close right after the process does; give the last
              // stderr chunk (the fatal message) a moment to land in the tail.
              await Promise.race([
                stderr.done,
                new Promise((resolve) => setTimeout(resolve, 500)),
              ]);
              return {
                exitCode: child.exitCode,
                signal: child.signalCode,
                stderr: stderr.tail(),
              };
            }),
          kill: () => child.kill("SIGKILL"),
        };
      }),
    ),
  );

const makeNode = () =>
  make((command, args, config, configuredAddresses) => {
    const stderrTail = makeTail();
    return Effect.try({
      try: () =>
        NodeChildProcess.spawn(command, args, {
          env: externalEnv(),
          stdio: ["pipe", "pipe", "pipe", "pipe"],
          killSignal: "SIGKILL",
        }),
      catch: (error) =>
        new SystemError({
          subtag: "WorkerdSpawn",
          message: "Failed to spawn the Workers runtime (workerd) process.",
          cause: error,
        }),
    }).pipe(
      Effect.tap((child) =>
        Effect.callback<void, SystemError>((resume) => {
          const onSpawn = () => {
            child.off("error", onError);
            resume(Effect.void);
          };
          const onError = (error: unknown) => {
            resume(
              new SystemError({
                subtag: "WorkerdStart",
                message:
                  "Failed to start the Workers runtime (workerd) process.",
                cause: error,
              }),
            );
          };
          child.once("spawn", onSpawn);
          child.once("error", onError);
          return Effect.sync(() => {
            child.kill("SIGKILL");
            child.off("spawn", onSpawn);
            child.off("error", onError);
          });
        }),
      ),
      Effect.tap((child) =>
        Effect.sync(() => {
          child.stderr.on("data", (chunk: Buffer) => {
            stderrTail.push(chunk.toString());
          });
        }),
      ),
      Effect.map((child) => ({
        configure: () =>
          Effect.callback((resume) => {
            const onError = (
              cause: unknown,
              message: string = "Failed to write to the workerd process stdin.",
            ) => {
              resume(
                new SystemError({ subtag: "WorkerdSpawn", message, cause }),
              );
            };
            if (!child.stdin) {
              return onError(
                undefined,
                "The workerd process did not have a stdin.",
              );
            }
            child.stdin.on("error", onError);
            child.stdin.end(config, () => {
              resume(Effect.void);
              child.stdin?.off("error", onError);
            });
            return Effect.sync(() => {
              child.stdin?.off("error", onError);
            });
          }),
        control: (count) =>
          Effect.callback((resume) => {
            const pipe = child.stdio[3];
            if (!pipe) {
              return resume(
                new SystemError({
                  subtag: "WorkerdSpawn",
                  message: "The workerd process did not have a control fd.",
                }),
              );
            }
            let lines = "";
            const onEnd = () => {
              pipe.off("data", onData);
              if ("closed" in pipe && !pipe.closed) {
                pipe.destroy();
              }
            };
            const onData = (data: Buffer) => {
              lines += data.toString();
              const messages = lines
                .split("\n")
                .filter((line) => line.trim() !== "")
                .map((line) => JSON.parse(line) as ControlMessage);
              if (messages.length === count) {
                onEnd();
                return resume(Effect.succeed(messages));
              }
            };
            // We intentionally don't listen for `end` or `error` because:
            // - workerd doesn't close the pipe itself; we have to do it ourselves when we have all our messages
            // - errors from here are a symptom and don't tell us what's actually wrong, so we let the error callback handle it
            pipe.on("data", onData);
            return Effect.sync(onEnd);
          }),
        error: () =>
          Effect.callback((resume) => {
            let stderr = "";
            const onData = (data: Buffer) => {
              stderr += data.toString();
            };
            const onError = () => {
              resume(
                classifyWorkerdError(
                  stderr || "Node child process stderr is empty.",
                  child.exitCode,
                  child.signalCode,
                  configuredAddresses,
                ),
              );
            };
            child.stderr.on("data", onData);
            child.stderr.on("end", onError);
            child.stderr.on("error", onError);
            return Effect.sync(() => {
              child.stderr?.off("data", onData);
              child.stderr?.off("end", onError);
              child.stderr?.off("error", onError);
            });
          }),
        pipe: (sink) => {
          const stdoutDecoder = new TextDecoder();
          const stderrDecoder = new TextDecoder();
          const onStdout = (chunk: Buffer) => {
            if (sink)
              sink(stdoutDecoder.decode(chunk, { stream: true }), "stdout");
            else process.stdout.write(chunk);
          };
          const onStderr = (chunk: Buffer) => {
            if (sink)
              sink(stderrDecoder.decode(chunk, { stream: true }), "stderr");
            else process.stderr.write(chunk);
          };
          return Effect.acquireRelease(
            Effect.sync(() => {
              child.stdout.on("data", onStdout);
              child.stderr.on("data", onStderr);
            }),
            () =>
              Effect.sync(() => {
                child.stdout.off("data", onStdout);
                child.stderr.off("data", onStderr);
              }),
          );
        },
        exited: () =>
          Effect.callback<WorkerdExit>((resume) => {
            const onClose = (
              exitCode: number | null,
              signal: NodeJS.Signals | null,
            ) => {
              resume(
                Effect.succeed({
                  exitCode,
                  signal,
                  stderr: stderrTail.read(),
                }),
              );
            };
            child.once("close", onClose);
            return Effect.sync(() => {
              child.off("close", onClose);
            });
          }),
        kill: () => child.kill("SIGKILL"),
      })),
    );
  });

// On Windows, `Bun.spawn` cannot surface extra stdio pipes: `child.stdio[3]`
// is a numeric fd that neither `Bun.file(fd)` (EMFILE dup) nor `node:fs`
// (EBADF) can read, so the `--control-fd=3` listen events never arrive and
// `serve` waits forever. Bun's `node:child_process` implementation handles
// stdio[3] correctly on Windows, so route Windows through the Node spawn path.
export const WorkerdLive = Layer.sync(Workerd, () =>
  typeof globalThis.Bun !== "undefined" && process.platform !== "win32"
    ? makeBun()
    : makeNode(),
);

const ADDRESS_IN_USE_SUBTAG = "AddressInUse" as const;

/**
 * Workerd writes failures to stderr in a few well-known shapes. This
 * classifier inspects the captured stderr and decides whether the failure
 * is a user-facing config error (bad worker script or config) or a
 * lower-level system error (port conflict, internal workerd error, etc.).
 */
const classifyWorkerdError = (
  stderr: string | undefined,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  configuredAddresses: Array<string>,
): ConfigError | SystemError => {
  const text = (stderr ?? "").trim();
  const detail = { stderr: text, exitCode, signal };
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Pattern: `service <name>: <message>` is workerd's way of reporting a
  // problem with one of the user's services (script load failure, missing
  // compatibility date, syntax error in user script, etc.).
  const serviceLine = lines.find((line) => /^service [^:]+:/.test(line));
  if (serviceLine) {
    const match = serviceLine.match(/^service ([^:]+): (.*)$/);
    const [, service, message] = match ?? [];
    return new ConfigError({
      subtag: "WorkerdUserScript",
      message: message ?? serviceLine,
      hint: service
        ? `Check the configuration for service "${service}".`
        : undefined,
      detail: { ...detail, service },
    });
  }

  // Pattern: address-in-use comes through as a `kj::Exception`. The offending
  // address was reported by the C++ backend; the Rust backend omits it.
  if (/Address already in use/i.test(text)) {
    const address = text.match(/toString\(\) = (\S+)/)?.[1];
    return new ConfigError({
      subtag: ADDRESS_IN_USE_SUBTAG,
      message: address
        ? `The Workers runtime could not bind to ${address} (already in use).`
        : configuredAddresses.length > 0
          ? `The Workers runtime could not bind (address already in use). Configured listeners: ${configuredAddresses.join(", ")}.`
          : "The Workers runtime could not bind to the requested address (already in use).",
      hint: "Pick a different port or stop the process using it.",
      detail: { ...detail, address, configuredAddresses },
    });
  }

  return new SystemError({
    subtag: "WorkerdStartFailed",
    message: "The Workers runtime failed to start.",
    detail,
  });
};

export const isAddressInUseError = (error: ConfigError | SystemError) => {
  if (error._tag === "ConfigError" && error.subtag === ADDRESS_IN_USE_SUBTAG) {
    return true;
  }
  // Windows-specific check for address-in-use errors; it doesn't always fail with a clear message.
  if (
    process.platform === "win32" &&
    error._tag === "SystemError" &&
    error.subtag === "WorkerdStartFailed" &&
    Predicate.hasProperty(error.detail, "stderr") &&
    Predicate.isString(error.detail.stderr) &&
    error.detail.stderr.includes(
      "*** std::terminate() called with no exception",
    )
  ) {
    return true;
  }
  return false;
};
