import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

const KEPT = "a".repeat(199);
// The emoji's two UTF-16 units straddle unit 200, where the server cuts a run's title.
const DEFINITION = `export default T3.workflow("titled", { version: 1, payload: Schema.Struct({}) },
  Effect.fn(function* () {
    yield* T3.title("${KEPT}😀 and the rest of the title");
  }));
`;

test(
  "A long workflow run title ends without a broken character",
  WEB,
  async ({ t3, app, screen }) => {
    const definition = await runPromise(
      Effect.map(Path.Path, (path) => path.join(T3_HOME, "workflows/titled.ts")),
    );
    const workflowsOn = (on: boolean) =>
      runPromise(
        Effect.gen(function* () {
          const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
          yield* client["server.updateSettings"]({ patch: { workflowsEnabled: on } });
        }).pipe(Effect.scoped),
      );
    try {
      await runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.makeDirectory(path.dirname(definition), { recursive: true });
          yield* fs.writeFileString(definition, DEFINITION);
        }),
      );
      await t3.project("demo");
      await workflowsOn(true);
      const started = await runPromise(
        makeState(T3_HOME).cli(["workflow", "start", "titled", "--key", "one", "--json"]),
      );
      const { run } = JSON.parse(started.stdout);
      await t3.open(`/workflows?run=${run.runId}`);

      // Until the title activity commits, the heading is the workflow's name and key.
      const heading = screen.getByRole("heading", KEPT, { exact: false });
      await heading.waitFor({ timeout: 30_000 });
      await app.screenshot("run-heading");
      await expect(heading).toHaveText(KEPT);
    } finally {
      await workflowsOn(false);
      await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(definition, { force: true })),
      );
    }
  },
);
