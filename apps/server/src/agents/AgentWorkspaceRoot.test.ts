import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AgentProfileInvalidError, ProjectId } from "@t3tools/contracts";

import { resolveAgentWorkspaceRootForScope } from "./AgentWorkspaceRoot.ts";

describe("agent workspace root resolution", () => {
  it.effect("ignores an irrelevant project id for environment-scoped entries", () =>
    Effect.gen(function* () {
      const root = yield* resolveAgentWorkspaceRootForScope(
        "environment",
        ProjectId.make("deleted"),
        () => Effect.die(new Error("must not resolve project")),
      );

      assert.isUndefined(root);
    }),
  );

  it.effect("requires a project for project-scoped entries", () =>
    Effect.gen(function* () {
      const exit = yield* resolveAgentWorkspaceRootForScope("project", undefined, () =>
        Effect.succeed("unused"),
      ).pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Failure") {
        assert.instanceOf(Cause.squash(exit.cause), AgentProfileInvalidError);
      }
    }),
  );
});
