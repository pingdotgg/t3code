/**
 * The `alchemy-test` CLI.
 *
 * ```sh
 * alchemy-test [paths...] [-t pattern] [--timeout ms] [--retry n]
 *              [--concurrency n] [--sequential] [--tui]
 *              [--profile name] [--fast]
 * ```
 *
 * Runs every `*.test.ts` under the given paths (default `./test`) in a single
 * bun process. Interactive terminals get the opentui view; otherwise tests
 * are logged line-by-line and failures are dumped at the end.
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import packageJson from "../package.json" with { type: "json" };
import { PlainReporterLive, printSummary } from "./PlainReporter.ts";
import { Reporter } from "./Reporter.ts";
import { run, type RunOptions } from "./Runner.ts";
import { captureStrayOutput } from "./StrayOutput.ts";
import { TuiReporter } from "./Tui.ts";

const paths = Argument.string("paths").pipe(
  Argument.withDescription("Test files or directories (default: ./test)"),
  Argument.variadic(),
);

const testNamePattern = Flag.string("test-name-pattern").pipe(
  Flag.withAlias("t"),
  Flag.withDescription("Only run tests whose title matches this regex"),
  Flag.optional,
);

const timeout = Flag.integer("timeout").pipe(
  Flag.withDescription("Default per-test timeout in milliseconds"),
  Flag.withDefault(120_000),
);

const retry = Flag.integer("retry").pipe(
  Flag.withDescription(
    "Times a failing test is retried before failing the run",
  ),
  Flag.withDefault(2),
);

const concurrency = Flag.string("concurrency").pipe(
  Flag.withAlias("c"),
  Flag.withDescription(
    'Maximum number of files running concurrently: a number (default 32) or "unbounded". Unbounded runs of large suites saturate the event loop and drown real failures in spurious 0ms beforeAll timeouts.',
  ),
  Flag.withDefault("32"),
);

const toConcurrency = (value: string): number | "unbounded" => {
  if (value === "unbounded") return "unbounded";
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(
      `--concurrency must be a positive integer or "unbounded", got: ${value}`,
    );
  }
  return parsed;
};

const sequential = Flag.boolean("sequential").pipe(
  Flag.withDescription("Run tests within each file sequentially"),
  Flag.withDefault(false),
);

const tui = Flag.boolean("tui").pipe(
  Flag.withDescription(
    "Opt in to the interactive TUI (default is plain line output)",
  ),
  Flag.withDefault(false),
);

const profile = Flag.string("profile").pipe(
  Flag.withDescription(
    'Set ALCHEMY_PROFILE for the run (e.g. "testing") before any test module is imported',
  ),
  Flag.optional,
);

const fast = Flag.boolean("fast").pipe(
  Flag.withDescription(
    "Set FAST=1 — suites skip their slow tests (long-provisioning resources, smoke tests)",
  ),
  Flag.withDefault(false),
);

/**
 * Build the `-t` matcher — bun/vitest semantics: the pattern is a regex
 * tested against the full nested title (`file > describe chain > name`).
 * A syntactically INVALID regex (e.g. `-t "[worker"`) degrades to a literal
 * substring match instead of erroring.
 */
const toFilter = (
  pattern: Option.Option<string>,
): ((fullTitle: string) => boolean) | undefined =>
  Option.match(pattern, {
    onNone: () => undefined,
    onSome: (source) => {
      let regex: RegExp;
      try {
        regex = new RegExp(source);
      } catch {
        // Not a valid regex — treat it as a literal substring.
        regex = new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      }
      return (fullTitle) => regex.test(fullTitle);
    },
  });

const rootCommand = Command.make(
  "alchemy-test",
  {
    paths,
    testNamePattern,
    timeout,
    retry,
    concurrency,
    sequential,
    tui,
    profile,
    fast,
  },
  Effect.fn(function* (args) {
    // Environment knobs — set BEFORE any test module is imported (imports
    // happen inside `run` during collection), so `skipIf(process.env.FAST)`
    // gates and profile-dependent layers see the final values.
    //
    // CI=true: interactive-detection gates (`process.env.CI`, TTY probes)
    // make tools take "inherit the terminal" paths — e.g. drizzle-kit is
    // spawned with stdio: "inherit" when interactive — and raw child writes
    // to our TTY corrupt the reporter/TUI. CI=true forces every such tool
    // down its non-interactive path; anything they print through pipes or
    // the Console service is still captured per test.
    yield* Effect.sync(() => {
      process.env.CI ??= "true";
      if (Option.isSome(args.profile)) {
        process.env.ALCHEMY_PROFILE = args.profile.value;
      }
      if (args.fast) {
        process.env.FAST = "1";
      }
    });

    // Plain line output by default; the TUI is opt-in (`--tui`) and requires
    // an interactive terminal.
    const interactive = args.tui && process.stdout.isTTY === true;
    const path = yield* Path.Path;
    const root = process.cwd();
    // Per-run log file (timestamp + pid) so concurrent runs in different
    // terminals never trample each other's logs.
    const timestamp = new Date()
      .toISOString()
      .slice(0, 19)
      .replaceAll(":", "-");
    const logFile = path.resolve(
      root,
      ".alchemy",
      "log",
      "test",
      `${timestamp}-pid${process.pid}.log`,
    );

    const options: RunOptions = {
      root,
      paths: args.paths,
      filter: toFilter(args.testNamePattern),
      timeout: args.timeout,
      retry: args.retry,
      concurrency: toConcurrency(args.concurrency),
      sequential: args.sequential,
      logFile,
    };

    // In plain mode, divert stray JS-level stdout/stderr writes into the
    // run log for the duration of the run (the reporter writes through the
    // real stream); the TUI installs its own diversion after the renderer
    // is created.
    const restoreStrayCapture = interactive
      ? undefined
      : captureStrayOutput(logFile);

    const summary = yield* Effect.gen(function* () {
      const reporter = yield* Reporter;
      const summary = yield* run(options);
      yield* reporter.waitForExit(summary);
      return summary;
    }).pipe(
      Effect.provide(interactive ? TuiReporter(logFile) : PlainReporterLive),
      Effect.scoped,
      Effect.onExit(() => Effect.sync(() => restoreStrayCapture?.())),
    );

    // After the TUI tears down, leave a plain record in the terminal.
    if (interactive) {
      yield* printSummary(summary);
    }

    // Point agents/tooling at the full run log, with its size so the reader
    // knows what they're getting into before opening it.
    yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stats = yield* fs
        .stat(logFile)
        .pipe(Effect.orElseSucceed(() => undefined));
      const contents = yield* fs
        .readFileString(logFile)
        .pipe(Effect.orElseSucceed(() => ""));
      const lines = contents === "" ? 0 : contents.split("\n").length;
      const kb = stats === undefined ? 0 : Number(stats.size) / 1024;
      yield* Effect.sync(() => {
        process.stdout.write(
          `\nFull log: ${logFile} (${lines} lines, ${kb.toFixed(1)} KB)\n`,
        );
      });
    });

    if (summary.failed > 0) {
      yield* Effect.sync(() => {
        process.exitCode = 1;
      });
    }
  }),
);

const cli = Command.run(rootCommand, {
  version: packageJson.version,
});

cli.pipe(
  Effect.provide(Layer.mergeAll(BunServices.layer)),
  Effect.scoped,
  (effect) =>
    BunRuntime.runMain(effect as Effect.Effect<void>, {
      // ALWAYS exit once the main effect completes. runMain's default only
      // force-exits on failure/signal — but tests can leak live handles
      // (vite watchers, workerd sidecar sockets, keep-alive agents) that
      // keep bun's event loop alive forever after a green run. Everything
      // is already flushed by now (summary + log written in the main
      // effect); the macrotask hop lets any buffered stdout drain.
      teardown: (exit, onExit) => {
        Runtime.defaultTeardown(exit, (code) => {
          const finalCode =
            code !== 0 ? code : Number(process.exitCode ?? 0) || 0;
          setTimeout(() => process.exit(finalCode), 0);
          onExit(finalCode);
        });
      },
    }),
);
