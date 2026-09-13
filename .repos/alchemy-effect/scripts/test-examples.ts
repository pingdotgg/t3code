const examples = [
  "./examples/cloudflare-dev",
  "./examples/cloudflare-worker",
  "./examples/cloudflare-pr-package",
  "./examples/cloudflare-worker-async",
  "./examples/cloudflare-website-tanstack-start",
  "./examples/cloudflare-tanstack-start-solid",
  "./examples/cloudflare-neon-drizzle",
  "./examples/cloudflare-vue",
  "./examples/cloudflare-website-solidstart",
  "./examples/cloudflare-foldkit",
  "./examples/cloudflare-foldkit-ssr",
  "./examples/cloudflare-octane",
  "./examples/cloudflare-website-astro",
  "./examples/cloudflare-website-foldkit",
  "./examples/cloudflare-website-nextjs",
  "./examples/cloudflare-website-nuxt",
  "./examples/cloudflare-website-react-router",
  "./examples/cloudflare-website-sveltekit",
  "./examples/cloudflare-website-vite",
  "./examples/cloudflare-website-waku",
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
  // "./examples/railway-website-waku",
  // "./examples/railway-website-vocs",
  "./examples/fly-sprite",
  "./examples/fly-redis",
  "./examples/fly-bucket",
  "./examples/fly-postgres",
] as const;

type CommandResult = {
  label: string;
  command: readonly string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type TaskState = {
  label: string;
  command: readonly string[];
  cwd?: string;
  status: "pending" | "running" | "ok" | "failed";
  startedAt?: number;
  endedAt?: number;
  exitCode?: number | null;
};

const readStream = async (
  stream: ReadableStream<Uint8Array>,
): Promise<string> => new Response(stream).text();

const elapsedSeconds = (state: TaskState): string => {
  if (state.startedAt === undefined) {
    return "0s";
  }
  const endedAt = state.endedAt ?? performance.now();
  return `${Math.round((endedAt - state.startedAt) / 1000)}s`;
};

const makeStatusRenderer = (states: readonly TaskState[]) => {
  const interactive = process.stdout.isTTY === true;
  let renderedRows = 0;

  const taskLine = (state: TaskState) => {
    const icon =
      state.status === "ok"
        ? "ok"
        : state.status === "failed"
          ? "failed"
          : state.status;
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

  const fullLines = () => ["Example tests", ...states.map(taskLine)];

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
    const header = `Example tests (${done}/${states.length} ok)`;
    const activeLines = active.map(taskLine);
    let shown = activeLines.length;
    const fits = (count: number) => {
      const overflow = count < activeLines.length ? 1 : 0;
      return (
        rowsForAll([header, ...activeLines.slice(0, count)]) + overflow + 1 <=
        rows
      );
    };
    while (shown > 0 && !fits(shown)) {
      shown--;
    }
    return shown === activeLines.length
      ? [header, ...activeLines]
      : [
          header,
          ...activeLines.slice(0, shown),
          `  … ${activeLines.length - shown} more`,
        ];
  };

  return {
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

const run = async (
  state: TaskState,
  render: () => void,
): Promise<CommandResult> => {
  state.status = "running";
  state.startedAt = performance.now();
  render();

  const child = Bun.spawn([...state.command], {
    cwd: state.cwd,
    // Snapshot env at spawn time — `Bun.spawn` does not pick up later
    // `process.env` mutations, and we want `ALCHEMY_PROFILE` (and friends)
    // from the parent invocation.
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "inherit",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    readStream(child.stdout),
    readStream(child.stderr),
  ]);

  state.status = exitCode === 0 ? "ok" : "failed";
  state.exitCode = exitCode;
  state.endedAt = performance.now();
  render();

  return {
    label: state.label,
    command: state.command,
    exitCode,
    stdout,
    stderr,
  };
};

const runParallel = async (
  tasks: readonly {
    label: string;
    command: readonly string[];
    cwd?: string;
  }[],
): Promise<readonly CommandResult[]> => {
  const states = tasks.map((task): TaskState => ({
    ...task,
    status: "pending",
  }));
  const renderer = makeStatusRenderer(states);
  renderer.render();
  const interval = setInterval(() => renderer.render(), 1000);

  try {
    return await Promise.all(
      states.map((state) => run(state, () => renderer.render())),
    );
  } finally {
    clearInterval(interval);
    renderer.finish();
  }
};

const testResults = await runParallel(
  examples.map((example) => ({
    label: example,
    // Run `bun test` IN the example directory. Concurrent
    // `bun run --filter <workspace> test` all contend on bun's workspace
    // graph (each sits in `openat` walking the monorepo) and none of them
    // ever spawn the actual test process.
    command: ["bun", "test"] as const,
    cwd: example,
  })),
);
const failedTests = testResults.filter((result) => result.exitCode !== 0);

if (failedTests.length > 0) {
  console.error("\nFailed example tests:");
  for (const failure of failedTests) {
    const exit = failure.exitCode === null ? "signal" : failure.exitCode;
    console.error(
      `- ${failure.label} (exit ${exit}): ${failure.command.join(" ")}`,
    );
  }

  for (const failure of failedTests) {
    console.error(`\n--- ${failure.label} stdout ---`);
    if (failure.stdout.length > 0) {
      console.error(failure.stdout.trimEnd());
    } else {
      console.error("(empty)");
    }

    console.error(`\n--- ${failure.label} stderr ---`);
    if (failure.stderr.length > 0) {
      console.error(failure.stderr.trimEnd());
    } else {
      console.error("(empty)");
    }
  }
  process.exit(1);
}

const [formatFailure] = await runParallel([
  { label: "format", command: ["bun", "run", "format"] },
]);
if (formatFailure.exitCode !== 0) {
  console.error("\nFormat failed:");
  if (formatFailure.stdout.length > 0) {
    console.error(formatFailure.stdout.trimEnd());
  }
  if (formatFailure.stderr.length > 0) {
    console.error(formatFailure.stderr.trimEnd());
  }
  process.exit(formatFailure.exitCode ?? 1);
}
