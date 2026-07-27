import * as AWS from "@/AWS";
import { Graph } from "@/AWS/Detective/Graph.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as detective from "@distilled.cloud/aws/detective";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { makeDetectiveTestLease } from "./TestLease.ts";

const { test, beforeAll, afterAll } = Test.make({
  providers: AWS.providers(),
});
const testLease = makeDetectiveTestLease();

beforeAll(testLease.acquire, { timeout: 240_000 });
afterAll(testLease.release);

const firstGraphArn = detective
  .listGraphs({})
  .pipe(Effect.map((r) => r.GraphList?.[0]?.Arn));

// The Detective behavior graph is an account/region singleton. This test only
// runs when the account has no graph — it must never delete a graph the user
// already operates (capture-and-restore safety).
test.provider(
  "lifecycle: enable behavior graph, retag, disable",
  (stack) =>
    Effect.gen(function* () {
      const preexisting = yield* firstGraphArn;
      if (preexisting) {
        yield* Effect.logInfo(
          `Detective graph ${preexisting} already exists — skipping destructive lifecycle test`,
        );
        return;
      }

      yield* stack.destroy();

      // Create — enable the behavior graph with tags.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Graph("Graph", { tags: { env: "test" } });
        }),
      );
      expect(created.graphArn).toContain(":graph:");

      // Out-of-band verification.
      const live = yield* firstGraphArn;
      expect(live).toBe(created.graphArn);
      const tags = yield* detective.listTagsForResource({
        ResourceArn: created.graphArn,
      });
      expect(tags.Tags?.["env"]).toBe("test");
      expect(tags.Tags?.["alchemy::id"]).toBe("Graph");

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(Graph);
      const all = yield* provider.list();
      expect(all.some((g) => g.graphArn === created.graphArn)).toBe(true);

      // Update — retag in place (no replacement; ARN is stable).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Graph("Graph", { tags: { env: "prod" } });
        }),
      );
      expect(updated.graphArn).toBe(created.graphArn);
      const updatedTags = yield* detective.listTagsForResource({
        ResourceArn: created.graphArn,
      });
      expect(updatedTags.Tags?.["env"]).toBe("prod");

      // Destroy — the graph is deleted and the region is clean again.
      yield* stack.destroy();
      const after = yield* firstGraphArn;
      expect(after).toBeUndefined();
    }),
  { timeout: 180_000 },
);
