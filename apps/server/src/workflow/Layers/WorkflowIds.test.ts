import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { WorkflowIds } from "../Services/WorkflowIds.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";

const layer = it.layer(DeterministicWorkflowIds);

layer("DeterministicWorkflowIds", (it) => {
  it.effect("produces stable, prefixed, incrementing ids", () =>
    Effect.gen(function* () {
      const ids = yield* WorkflowIds;
      assert.equal(yield* ids.ticketId(), "ticket-1");
      assert.equal(yield* ids.ticketId(), "ticket-2");
      assert.equal(yield* ids.token(), "token-1");
      assert.equal(yield* ids.stepRunId(), "steprun-1");
    }),
  );
});
