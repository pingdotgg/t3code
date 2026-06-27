import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";

const state: RelayAgentActivityState = {
  environmentId: "env-1" as RelayAgentActivityState["environmentId"],
  threadId: "thread-1" as RelayAgentActivityState["threadId"],
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "gpt-5.4",
  phase: "running",
  headline: "Running",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deepLink: "/threads/env-1/thread-1",
};

describe("AgentActivityRows", () => {
  it.effect("preserves activity context on persistence failures", () => {
    const cause = new Error("database unavailable");
    const failingDb = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => Effect.fail(cause),
        }),
      }),
      delete: () => ({
        where: () => Effect.fail(cause),
      }),
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              orderBy: () => Effect.fail(cause),
            }),
          }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const rows = yield* AgentActivityRows.AgentActivityRows;

      const upsertError = yield* rows
        .upsert({ environmentPublicKey: "public-key", state })
        .pipe(Effect.flip);
      expect(upsertError).toMatchObject({
        environmentId: "env-1",
        threadId: "thread-1",
        cause,
      });
      expect(upsertError.message).toBe(
        "Failed to persist agent activity state for environment env-1, thread thread-1.",
      );

      const deleteError = yield* rows
        .remove({
          environmentId: "env-1",
          environmentPublicKey: "public-key",
          threadId: "thread-1",
        })
        .pipe(Effect.flip);
      expect(deleteError).toMatchObject({
        environmentId: "env-1",
        threadId: "thread-1",
        cause,
      });
      expect(deleteError.message).toBe(
        "Failed to delete agent activity state for environment env-1, thread thread-1.",
      );

      const listError = yield* rows.listForUser({ userId: "user-2" }).pipe(Effect.flip);
      expect(listError).toMatchObject({ userId: "user-2", cause });
      expect(listError.message).toBe("Failed to list agent activity state for user user-2.");
    }).pipe(
      Effect.provide(
        AgentActivityRows.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, failingDb))),
      ),
    );
  });
});
