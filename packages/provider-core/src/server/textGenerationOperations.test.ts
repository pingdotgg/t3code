import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

import {
  decodeJsonReply,
  fromRunner,
  type Request,
  type Runner,
} from "./textGenerationOperations.ts";

it.effect("preserves investigation metadata without preparing provider-specific evidence", () =>
  Effect.gen(function* () {
    let prepared = 0;
    let investigation: Request<Schema.Top>["investigate"];
    const evidence = Effect.sync(() => {
      prepared++;
      return { manifestPath: "/fixture/manifest.json", headCommit: "b".repeat(40) };
    });
    const stack = [
      { number: 1, title: "A layer", state: "open" as const, headSha: "b".repeat(40) },
    ];
    const run: Runner = (request) => {
      investigation = request.investigate;
      return decodeJsonReply(request, "Fixture", '{"stops":[]}');
    };
    const generated = yield* fromRunner("Fixture", run).generateReviewGuide({
      cwd: "/fixture",
      number: 1,
      title: "A layer",
      description: "",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      settledReview: "",
      stack,
      evidence,
      modelSelection: createModelSelection(ProviderInstanceId.make("fixture"), "default"),
    });
    assert.deepEqual(generated, { stops: [] });
    assert.equal(investigation?.timeoutMs, 900_000);
    assert.equal(investigation?.baseCommit, "a".repeat(40));
    assert.strictEqual(investigation?.stack, stack);
    assert.strictEqual(investigation?.evidence, evidence);
    assert.equal(prepared, 0);
  }),
);
