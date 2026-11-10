/**
 * Runs every example's test suite, then drives each example through the CLI
 * lifecycle (`scripts/test-example-cli.ts`), then checks formatting.
 *
 * Usage: node scripts/test-examples.ts [--profile <name>]
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Command, Flag } from "effect/cli";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Runtime from "effect/Runtime";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { preferLocalFlociImage } from "./floci-image.ts";

/** Ends the run with `code` after the reason has already been printed. */
class ExitWith extends Data.TaggedError("ExitWith")<{ readonly code: number }> {
  readonly [Runtime.errorReported] = false;
  get [Runtime.errorExitCode]() {
    return this.code;
  }
}

const examples = [
  "./examples/cloudflare-dev",
  "./examples/cloudflare-worker",
  "./examples/cloudflare-worker-async",
  "./examples/cloudflare-website-tanstack-start",
  "./examples/cloudflare-tanstack-start-solid",
  "./examples/cloudflare-neon-drizzle",
  "./examples/cloudflare-vue",
  "./examples/cloudflare-website-solidstart",
  "./examples/cloudflare-foldkit-spa",
  "./examples/cloudflare-foldkit-ssr",
  "./examples/cloudflare-foldkit-ssg",
  "./examples/cloudflare-foldkit-hybrid",
  "./examples/cloudflare-octane",
  "./examples/cloudflare-website-astro",
  "./examples/cloudflare-website-nextjs",
  "./examples/cloudflare-website-nuxt",
  "./examples/cloudflare-website-react-router",
  "./examples/cloudflare-website-sveltekit",
  "./examples/cloudflare-website-service-bindings",
  "./examples/cloudflare-website-vite",
  "./examples/cloudflare-website-vinext",
  "./examples/cloudflare-website-waku",
  "./examples/cloudflare-website-vocs",
  "./examples/cloudflare-agents",
  "./examples/cloudflare-flue",
  "./examples/aws-dev",
  // "./examples/aws-ecs",
  "./examples/aws-lambda",
  // Cloudfront is too slow
  // "./examples/aws-website-astro",
  // "./examples/aws-website-foldkit",
  // "./examples/aws-website-nextjs",
  // "./examples/aws-website-nuxt",
  // "./examples/aws-website-react-router",
  // "./examples/aws-website-solidstart",
  // "./examples/aws-website-sveltekit",
  // "./examples/aws-website-tanstack-start",
  // "./examples/aws-website-vite",
  // "./examples/aws-website-vinext",
  // "./examples/aws-website-waku",
  "./examples/fly-app",
  "./examples/fly-service",
  "./examples/fly-website-vite",
  "./examples/hetzner-website-vite",
  // Railway examples are gated out of test:examples for now: repeated
  // Railway platform outages (deployment queue backlogs, e.g. the
  // 2026-08-28 "Deployments slow to start" incident) and general
  // flakiness working with Railway's API make these suites too
  // unreliable for CI. Run them from the example directory with
  // `bun test` when Railway is healthy.
  // "./examples/railway-project",
  // "./examples/railway-service",
  // "./examples/railway-website-vite",
  // Card-app Website composites (same apps as the AWS/Cloudflare
  // *-website-* examples). Commented so CI does not provision extra
  // sites; run them from the example directory with `bun test`.
  // "./examples/fly-website-astro",
  // "./examples/fly-website-foldkit",
  // "./examples/fly-website-nextjs",
  // "./examples/fly-website-nuxt",
  // "./examples/fly-website-react-router",
  // "./examples/fly-website-solidstart",
  // "./examples/fly-website-sveltekit",
  // "./examples/fly-website-tanstack-start",
  // "./examples/fly-website-vinext",
  // "./examples/fly-website-waku",
  // "./examples/fly-website-vocs",
  // "./examples/hetzner-website-astro",
  // "./examples/hetzner-website-foldkit",
  // "./examples/hetzner-website-nextjs",
  // "./examples/hetzner-website-nuxt",
  // "./examples/hetzner-website-react-router",
  // "./examples/hetzner-website-solidstart",
  // "./examples/hetzner-website-sveltekit",
  // "./examples/hetzner-website-tanstack-start",
  // "./examples/hetzner-website-vinext",
  // "./examples/hetzner-website-waku",
  // "./examples/hetzner-website-vocs",
  // "./examples/railway-website-astro",
  // "./examples/railway-website-foldkit",
  // "./examples/railway-website-nextjs",
  // "./examples/railway-website-nuxt",
  // "./examples/railway-website-react-router",
  // "./examples/railway-website-solidstart",
  // "./examples/railway-website-sveltekit",
  // "./examples/railway-website-tanstack-start",
  // "./examples/railway-website-vinext",
  // "./examples/railway-website-waku",
  // "./examples/railway-website-vocs",
  "./examples/fly-sprite",
  "./examples/fly-redis",
  "./examples/fly-bucket",
  "./examples/fly-postgres",
] as const;

// The AWS examples share one floci emulator container (`alchemy-floci`):
// two `alchemy dev` sessions ensuring it at the same time race to recreate
// it on an image bump and hot-swap each other's Lambda code, so they run
// one at a time. Everything else stays concurrent.
const serialGroup = (example: string): string | undefined =>
  example.startsWith("./examples/aws-") ? "floci" : undefined;

type CommandResult = {
  label: string;
  command: readonly string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type Task = {
  label: string;
  command: readonly string[];
  /** Relative to the repository root; defaults to it. */
  cwd?: string;
  /** Tasks sharing a key run one at a time, in list order. */
  serial?: string;
};

type TaskState = Task & {
  status: "pending" | "running" | "ok" | "failed";
  startedAt?: number;
  endedAt?: number;
  exitCode?: number | null;
};

const elapsedSeconds = (state: TaskState): string => {
  if (state.startedAt === undefined) {
    return "0s";
  }
  const endedAt = state.endedAt ?? performance.now();
  return `${Math.round((endedAt - state.startedAt) / 1000)}s`;
};

const makeStatusRenderer = (title: string, states: readonly TaskState[]) => {
  const interactive = process.stdout.isTTY === true;
  let renderedRows = 0;

  const taskLine = (state: TaskState) => {
    const icon = state.status === "ok" ? "ok" : state.status === "failed" ? "failed" : state.status;
    const exit =
      state.exitCode === undefined || state.exitCode === 0
        ? ""
        : ` exit ${state.exitCode ?? "signal"}`;
    return `  ${icon.padEnd(7)} ${state.label} ${elapsedSeconds(state)}${exit}`;
  };

  // Physical rows a line occupies once the terminal wraps it.
  const rowsFor = (line: string) => {
    const columns = process.stdout.columns || 80;
    return Math.max(1, Math.ceil(line.length / columns));
  };
  const rowsForAll = (output: readonly string[]) =>
    output.reduce((total, line) => total + rowsFor(line), 0);

  const fullLines = () => [title, ...states.map(taskLine)];

  // The in-place repaint moves the cursor up with `\x1b[NF`, which cannot
  // climb above the top of the viewport: if a paint is taller than the
  // terminal (or lines wrap), the write scrolls and every repaint leaks its
  // topmost rows into scrollback. Keep each paint strictly shorter than the
  // viewport by collapsing finished tasks into the header once space runs
  // out (`+ 1` accounts for the cursor parking on the row below the paint).
  const lines = () => {
    const rows = process.stdout.rows || 24;
    const full = fullLines();
    if (rowsForAll(full) + 1 <= rows) {
      return full;
    }
    const done = states.filter((state) => state.status === "ok").length;
    const active = states.filter((state) => state.status !== "ok");
    const header = `${title} (${done}/${states.length} ok)`;
    const activeLines = active.map(taskLine);
    let shown = activeLines.length;
    const fits = (count: number) => {
      const overflow = count < activeLines.length ? 1 : 0;
      return rowsForAll([header, ...activeLines.slice(0, count)]) + overflow + 1 <= rows;
    };
    while (shown > 0 && !fits(shown)) {
      shown--;
    }
    return shown === activeLines.length
      ? [header, ...activeLines]
      : [header, ...activeLines.slice(0, shown), `  … ${activeLines.length - shown} more`];
  };

  return {
    failure(result: CommandResult) {
      if (interactive && renderedRows > 0) {
        process.stdout.write(`\x1b[${renderedRows}F\x1b[J`);
        renderedRows = 0;
      }
      const output = [
        `\nFailed: ${result.label} (exit ${result.exitCode ?? "signal"}): ${result.command.join(" ")}`,
        `--- ${result.label} stdout ---`,
        result.stdout.trimEnd() || "(empty)",
        `--- ${result.label} stderr ---`,
        result.stderr.trimEnd() || "(empty)",
        "",
      ].join("\n");
      // Use the TUI's stream so its next repaint starts below the logs.
      (interactive ? process.stdout : process.stderr).write(output);
      this.render();
    },
    render() {
      if (!interactive) {
        return;
      }
      if (renderedRows > 0) {
        process.stdout.write(`\x1b[${renderedRows}F\x1b[J`);
      }
      const output = lines();
      process.stdout.write(`${output.join("\n")}\n`);
      renderedRows = rowsForAll(output);
    },
    finish() {
      if (interactive && renderedRows > 0) {
        process.stdout.write(`\x1b[${renderedRows}F\x1b[J`);
        renderedRows = 0;
      }
      // Always end with the full table (the live view may be compacted).
      for (const line of fullLines()) {
        console.log(line);
      }
    },
  };
};

const runTask = Effect.fn(function* (
  state: TaskState,
  env: Record<string, string>,
  render: Effect.Effect<void>,
) {
  const spawner = yield* ChildProcessSpawner;
  const path = yield* Path.Path;
  const repoRoot = path.resolve(import.meta.dirname, "..");

  yield* Effect.sync(() => {
    state.status = "running";
    state.startedAt = performance.now();
  });
  yield* render;

  const { exitCode, stdout, stderr } = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(state.command[0]!, state.command.slice(1), {
          cwd: path.resolve(repoRoot, state.cwd ?? "."),
          env,
          extendEnv: true,
          // Not detached: terminal Ctrl-C reaches every task directly.
          detached: false,
          stdin: "inherit",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      return yield* Effect.all(
        {
          exitCode: child.exitCode.pipe(
            Effect.map((code): number | null => code),
            // Terminated by a signal.
            Effect.orElseSucceed(() => null),
          ),
          stdout: child.stdout.pipe(Stream.decodeText, Stream.mkString),
          stderr: child.stderr.pipe(Stream.decodeText, Stream.mkString),
        },
        { concurrency: "unbounded" },
      );
    }),
  ).pipe(
    // A command that cannot start (e.g. missing binary) fails the task.
    Effect.catch((error) =>
      Effect.succeed({ exitCode: null, stdout: "", stderr: String(error.message ?? error) }),
    ),
  );

  yield* Effect.sync(() => {
    state.status = exitCode === 0 ? "ok" : "failed";
    state.exitCode = exitCode;
    state.endedAt = performance.now();
  });
  yield* render;

  return {
    label: state.label,
    command: state.command,
    exitCode,
    stdout,
    stderr,
  } satisfies CommandResult;
});

const runParallel = Effect.fn(function* (
  title: string,
  tasks: readonly Task[],
  env: Record<string, string>,
  options?: { readonly concurrency?: number },
) {
  const states = tasks.map((task): TaskState => ({
    ...task,
    status: "pending",
  }));
  const renderer = yield* Effect.sync(() => makeStatusRenderer(title, states));
  const render = Effect.sync(() => renderer.render());

  // At most `concurrency` tasks run at once; the rest wait for a slot.
  // Serial tasks queue on their group before taking a slot, in list order.
  const slots = yield* Semaphore.make(options?.concurrency ?? Number.MAX_SAFE_INTEGER);
  const serial = new Map<string, Semaphore.Semaphore>();
  for (const task of tasks) {
    if (task.serial !== undefined && !serial.has(task.serial)) {
      serial.set(task.serial, yield* Semaphore.make(1));
    }
  }

  const run = Effect.forEach(
    states,
    (state) => {
      const start = runTask(state, env, render).pipe(
        Effect.tap((result) =>
          result.exitCode === 0 ? Effect.void : Effect.sync(() => renderer.failure(result)),
        ),
        Semaphore.withPermits(slots, 1),
      );
      return state.serial === undefined
        ? start
        : start.pipe(Semaphore.withPermits(serial.get(state.serial)!, 1));
    },
    { concurrency: "unbounded" },
  );

  yield* render;
  return yield* run.pipe(
    Effect.raceFirst(
      render.pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.andThen(Effect.never)),
    ),
    Effect.ensuring(Effect.sync(() => renderer.finish())),
  );
});

const command = Command.make(
  "test-examples",
  {
    profile: Flag.String("profile").pipe(
      Flag.withDescription(
        "Alchemy profile the example suites and CLI runs use (sets ALCHEMY_PROFILE)",
      ),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ profile }) {
    // The example suites read the profile from `ALCHEMY_PROFILE`
    // (`Test.make({ profile: process.env.ALCHEMY_PROFILE })`), so translate
    // the flag into the env every spawned `bun test` inherits.
    const env: Record<string, string> = Option.isSome(profile)
      ? { ALCHEMY_PROFILE: profile.value }
      : {};

    // The AWS examples run against the floci emulator: use the locally built
    // image when there is one so an emulator fix is testable before its
    // release image lands on GHCR.
    yield* preferLocalFlociImage("test:examples");

    const testResults = yield* runParallel(
      "Example tests",
      examples.map((example) => ({
        label: example,
        // Run `bun test` IN the example directory. Concurrent
        // `bun run --filter <workspace> test` all contend on bun's workspace
        // graph (each sits in `openat` walking the monorepo) and none of them
        // ever spawn the actual test process.
        command: ["bun", "test"] as const,
        cwd: example,
        serial: serialGroup(example),
      })),
      env,
    );
    const failedTests = testResults.filter((result) => result.exitCode !== 0);

    if (failedTests.length > 0) {
      yield* Console.error("\nFailed example tests:");
      for (const failure of failedTests) {
        const exit = failure.exitCode === null ? "signal" : failure.exitCode;
        yield* Console.error(`- ${failure.label} (exit ${exit}): ${failure.command.join(" ")}`);
      }
      return yield* new ExitWith({ code: 1 });
    }

    const cliResults = yield* runParallel(
      "Example CLI lifecycle",
      examples.map((example) => ({
        label: `${example} CLI lifecycle`,
        command: ["node", "scripts/test-example-cli.ts", example],
        serial: serialGroup(example),
      })),
      env,
      // Each `alchemy dev` session is a CLI, an exec child, sidecars, workerd
      // and a bundler watch loop; 30 at once starve each other past the
      // 4-minute readiness timeout.
      { concurrency: 8 },
    );
    const failedCliTests = cliResults.filter((result) => result.exitCode !== 0);

    if (failedCliTests.length > 0) {
      yield* Console.error("\nFailed example CLI lifecycle tests:");
      for (const failure of failedCliTests) {
        const exit = failure.exitCode === null ? "signal" : failure.exitCode;
        yield* Console.error(`- ${failure.label} (exit ${exit})`);
      }
      return yield* new ExitWith({ code: 1 });
    }

    const [formatFailure] = yield* runParallel(
      "Format",
      [{ label: "format", command: ["bun", "run", "format"] }],
      env,
    );
    if (formatFailure!.exitCode !== 0) {
      yield* Console.error("\nFormat failed:");
      if (formatFailure!.stdout.length > 0) yield* Console.error(formatFailure!.stdout.trimEnd());
      if (formatFailure!.stderr.length > 0) yield* Console.error(formatFailure!.stderr.trimEnd());
      return yield* new ExitWith({ code: formatFailure!.exitCode ?? 1 });
    }
  }),
).pipe(Command.withDescription("Run the example suites, CLI lifecycles and format check"));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
