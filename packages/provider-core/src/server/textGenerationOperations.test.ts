import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decodeJsonReply, fromRunner } from "./textGenerationOperations.ts";

it.effect("returns an ordered split commit plan through the shared provider runner", () =>
  Effect.gen(function* () {
    const generation = fromRunner("Test", (request) =>
      decodeJsonReply(
        request,
        "Test",
        JSON.stringify({
          commits: [
            { subject: " Add schema.\nExtra prose", body: "  Foundation  ", hunkIds: [" h1 "] },
            { subject: "Use schema", body: "", hunkIds: ["h2", "h3"] },
          ],
        }),
      ),
    );
    const plan = yield* generation.generateCommitPlan({
      cwd: "/repo",
      branch: "feature/schema",
      changeUnitSummary: "h1 schema; h2 implementation; h3 tests",
      annotatedPatch: "h1 +schema\nh2 +implementation\nh3 +tests",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    });
    expect(plan).toEqual({
      commits: [
        { subject: "Add schema", body: "Foundation", hunkIds: ["h1"] },
        { subject: "Use schema", body: "", hunkIds: ["h2", "h3"] },
      ],
    });
  }),
);
