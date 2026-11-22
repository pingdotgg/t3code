import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as BotDraftStore from "./BotDraftStore.ts";
import * as BotStore from "./BotStore.ts";

const layer = Layer.mergeAll(BotStore.layer, BotDraftStore.layer).pipe(
  Layer.provide(Sqlite.layerMemory),
);

it.effect("persists which grant activated a resource and retains drafts after review", () =>
  Effect.gen(function* () {
    const bots = yield* BotStore.BotStore;
    const drafts = yield* BotDraftStore.BotDraftStore;
    const threadId = ThreadId.make("bot:draft-author");
    const profile = {
      name: "Automation author",
      role: "",
      description: "",
      icon: "",
      color: "#6366f1",
      instructions: "",
    };
    yield* bots.create({
      ...profile,
      threadId,
      projectId: ProjectId.make("project"),
      state: "active",
      revision: 1,
      access: { handoffProjects: [], writeSources: [] },
    });
    const grant = { threadId, resource: "schedule", source: "direct" } as const;
    yield* drafts.setGrant({ ...grant, enabled: true });
    assert.isTrue(yield* drafts.allows(grant));
    assert.isFalse(yield* drafts.allows({ ...grant, resource: "hook" }));
    assert.isFalse(yield* drafts.allows({ ...grant, source: "webhook" }));

    const submitted = yield* drafts.save({
      id: CommandId.make("proposal"),
      authorThreadId: threadId,
      authorRevision: 1,
      change: {
        type: "schedule",
        title: "Daily task",
        prompt: "Summarize the latest changes.",
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      },
    });
    assert.deepEqual(yield* drafts.findPending(submitted.id), submitted);
    yield* drafts.resolve(submitted.id, "approved", { source: grant.source, id: "task-id" });
    yield* drafts.setGrant({ ...grant, enabled: false });
    assert.isFalse(yield* drafts.allows(grant));
    assert.deepEqual(yield* drafts.activatedUnder(grant), ["task-id"]);
    assert.isUndefined(yield* drafts.findPending(submitted.id));
    assert.equal(
      (yield* drafts.automationOwner("task-id", threadId, "schedule"))?.authorization,
      "direct",
    );
    assert.isUndefined(
      yield* drafts.automationOwner("task-id", ThreadId.make("bot:unrelated"), "schedule"),
    );
  }).pipe(Effect.provide(layer)),
);
