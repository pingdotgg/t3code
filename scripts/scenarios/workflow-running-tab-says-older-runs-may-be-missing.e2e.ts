import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

// A run that sleeps stays running. The 500 ticks a burst invokes start after it, so the list's
// 500 newest runs leave it out.
const DEFINITIONS = `const tick = T3.workflow("tick", { version: 1, payload: Schema.Struct({}) }, () => Effect.void);

export default [
  tick,
  T3.workflow("napper", { version: 1, payload: Schema.Struct({}) },
    Effect.fn(function* () {
      yield* T3.sleep("nap", "1 day");
    })),
  T3.workflow("burst", { version: 1, payload: Schema.Struct({}) },
    Effect.fn(function* () {
      for (let index = 0; index < 500; index++) yield* T3.invoke(\`tick-\${index}\`, tick, {});
    })),
];
`;

test(
  "The Running tab says older runs may be missing when a running run falls off the list",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const definitions = await runPromise(
      Effect.map(Path.Path, (path) => path.join(T3_HOME, "workflows/run-list-limit.ts")),
    );
    const workflowsOn = (on: boolean) =>
      runPromise(
        Effect.gen(function* () {
          const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
          yield* client["server.updateSettings"]({ patch: { workflowsEnabled: on } });
        }).pipe(Effect.scoped),
      );
    const cli = makeState(T3_HOME).cli;
    const start = (workflow: string) =>
      runPromise(
        Effect.map(
          cli(["workflow", "start", workflow, "--key", "limit", "--json"]),
          (started) => JSON.parse(started.stdout).run.runId as string,
        ),
      );
    try {
      await runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.makeDirectory(path.dirname(definitions), { recursive: true });
          yield* fs.writeFileString(definitions, DEFINITIONS);
        }),
      );
      await t3.project("demo");
      await workflowsOn(true);
      await start("napper");
      await start("burst");
      // Once all 500 ticks the burst invokes are listed as done, the burst and the sleeping run
      // are past the list's 500 newest.
      await runPromise(
        Effect.gen(function* () {
          const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
          yield* client["workflows.subscribe"]({}).pipe(
            Stream.filter(
              (update) =>
                update.runs.filter((run) => run.workflow === "tick" && run.status === "completed")
                  .length === 500,
            ),
            Stream.runHead,
          );
        }).pipe(Effect.scoped, Effect.timeout("4 minutes")),
      );

      await browser.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await t3.open("/workflows");
      const running = screen.getByRole("button", { name: "Running", exact: true });
      await running.click();
      await expect(running).toHaveAttribute("aria-pressed", "true");
      // Capture the settled tabs, not the pressed tab's colour fade.
      await browser.evaluate(() => {
        for (const animation of document.getAnimations()) {
          if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
        }
        return null;
      });
      const runs = screen.getByRole("navigation", { name: "Workflow runs" });
      await app.screenshot("running-tab");
      await expect(runs).toContainText("Older runs may be missing.");
    } finally {
      await workflowsOn(false);
      await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(definitions, { force: true })),
      );
    }
  },
);
