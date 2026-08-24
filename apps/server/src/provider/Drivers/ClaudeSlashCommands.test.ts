import { describe, expect, it } from "@effect/vitest";
import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { rememberClaudeSlashCommands, retainClaudeSlashCommands } from "./ClaudeSlashCommands.ts";

const review: ServerProviderSlashCommand = {
  name: "review",
  description: "Review the diff",
};
const commit: ServerProviderSlashCommand = {
  name: "commit",
  description: "Commit changes",
};

describe("retainClaudeSlashCommands", () => {
  it("keeps a populated probe result", () => {
    expect(retainClaudeSlashCommands([review, commit], [review], true)).toEqual([review, commit]);
  });

  it("reuses the previous list when a failed probe is empty", () => {
    expect(retainClaudeSlashCommands([], [review, commit], true)).toEqual([review, commit]);
  });

  it("keeps a successful empty probe instead of stale commands", () => {
    expect(retainClaudeSlashCommands([], [review, commit], false)).toEqual([]);
  });

  it("passes through empty when there is no previous list", () => {
    expect(retainClaudeSlashCommands([], [], true)).toEqual([]);
  });
});

describe("rememberClaudeSlashCommands", () => {
  it.effect("keeps the snapshot empty after a successful empty probe then a failed probe", () =>
    Effect.gen(function* () {
      const lastGoodSlashCommands = yield* Ref.make<ReadonlyArray<ServerProviderSlashCommand>>([]);
      yield* rememberClaudeSlashCommands(lastGoodSlashCommands, {
        status: "ready",
        slashCommands: [review, commit],
      });
      yield* rememberClaudeSlashCommands(lastGoodSlashCommands, {
        status: "ready",
        slashCommands: [],
      });
      const snapshot = yield* rememberClaudeSlashCommands(lastGoodSlashCommands, {
        status: "error",
        slashCommands: [],
      });

      expect(snapshot.slashCommands).toEqual([]);
    }),
  );
});
