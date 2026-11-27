import { assert, it } from "@effect/vitest";
import { type MilestoneEvent, MilestoneId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as BotService from "./BotService.ts";
import { makeOrchestration, model, provideBots } from "./BotTestkit.ts";

const bot = { enabled: true, muteChildren: false } as const;

const milestone = (
  id: string,
  fields:
    | {
        readonly threadId: string;
        readonly type?: "thread.run_settled" | "thread.needs_input";
        /** The run whose agent step the thread is. */
        readonly stepOf?: string;
      }
    | { readonly workflowRunId: string },
): MilestoneEvent => {
  const envelope = {
    id: MilestoneId.make(id),
    occurredAt: "2026-11-20T00:00:00.000Z",
    projectId: ProjectId.make("project:a"),
    parentThreadId: null,
    actor: { type: "agent" as const },
    isSubagentChild: false,
  };
  if ("workflowRunId" in fields) {
    return {
      ...envelope,
      type: "workflow.run_ended",
      projectId: null,
      threadId: null,
      workflowRunId: fields.workflowRunId,
      workflow: "release",
      runTitle: "Release",
      parentWorkflowRunId: null,
      outcome: "completed",
      detail: null,
    };
  }
  const thread = {
    ...envelope,
    ...(fields.stepOf === undefined ? {} : { workflowRunId: fields.stepOf }),
  };
  return fields.type === "thread.needs_input"
    ? {
        ...thread,
        type: "thread.needs_input",
        threadId: ThreadId.make(fields.threadId),
        requestId: `request:${id}` as never,
        kind: "approval",
      }
    : {
        ...thread,
        type: "thread.run_settled",
        threadId: ThreadId.make(fields.threadId),
        runId: RunId.make(`run:${id}`),
        outcome: "completed",
      };
};

it.effect("keeps a Bot's memory in its own folder and refuses writes from other threads", () => {
  const orchestration = makeOrchestration();
  const botThread = orchestration.addThread("../bot", { botConfig: bot });
  orchestration.addThread("thread:plain");
  return Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    assert.deepStrictEqual(yield* bots.readFiles({ threadId: botThread.id }), {
      preferences: "",
      notes: [],
    });
    const refused = yield* bots
      .writeNote({
        threadId: ThreadId.make("thread:plain"),
        slug: "plan",
        title: "Plan",
        summary: "",
        body: "x",
      })
      .pipe(Effect.flip);
    assert.strictEqual(refused.reason, "not_a_bot");

    // A Bot from before notes were split keeps its notes.md as the note "notes".
    const { baseDir } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const botFolder = path.join(baseDir, "bots", "thread-~2e~2e~2fbot");
    yield* fileSystem.makeDirectory(botFolder, { recursive: true });
    yield* fileSystem.writeFileString(path.join(botFolder, "notes.md"), "# Old plan\n");

    yield* bots.writeNote({
      threadId: botThread.id,
      slug: "release",
      title: "Release 2.1",
      summary: "What ships and when",
      body: "Tag on Friday.",
    });
    yield* bots.appendPreference({ threadId: botThread.id, text: "Use pnpm" });
    yield* bots.appendPreference({ threadId: botThread.id, text: "  Small PRs  " });
    const files = yield* bots.readFiles({ threadId: botThread.id });
    assert.strictEqual(files.preferences, "Use pnpm\nSmall PRs\n");
    assert.deepStrictEqual(files.notes.map(({ slug, title }) => [slug, title]).sort(), [
      ["notes", "Notes"],
      ["release", "Release 2.1"],
    ]);
    assert.strictEqual(
      (yield* bots.readNote({ threadId: botThread.id, slug: "notes" })).body,
      "# Old plan\n",
    );
    assert.deepStrictEqual(
      (yield* bots.searchNotes({ threadId: botThread.id, query: "friday" })).map(
        ({ slug, excerpt }) => [slug, excerpt],
      ),
      [["release", "Tag on Friday."]],
    );
    yield* bots.deleteNote({ threadId: botThread.id, slug: "notes" });
    const missing = yield* bots
      .readNote({ threadId: botThread.id, slug: "notes" })
      .pipe(Effect.flip);
    assert.strictEqual(missing.reason, "note_not_found");

    // An archived Bot keeps its memory but can no longer change it.
    botThread.archivedAt = "2026-11-20T00:00:00.000Z";
    assert.isFalse(yield* bots.isBot(botThread.id));

    // "../bot" cannot climb out: its folder name is escaped.
    assert.deepStrictEqual(yield* fileSystem.readDirectory(path.join(baseDir, "bots")), [
      "thread-~2e~2e~2fbot",
    ]);
  }).pipe(provideBots(orchestration));
});

it.effect(
  "wakes a Bot when its workers or a watched run reaches a milestone, and not once it is settled",
  () => {
    const orchestration = makeOrchestration();
    const leader = orchestration.addThread("thread:bot", { botConfig: bot });
    orchestration.addThread("thread:worker", { groupedUnderThreadId: leader.id });
    orchestration.addThread("thread:plain-worker", {
      groupedUnderThreadId: orchestration.addThread("thread:plain-leader").id,
    });
    return Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      yield* bots.addWatch(leader.id, { workflowRunId: "run:release", reason: "manual" });

      yield* bots.handleMilestone(milestone("other", { threadId: "thread:other" }));
      // A leader that is not a Bot is never woken.
      yield* bots.handleMilestone(milestone("plain", { threadId: "thread:plain-worker" }));
      yield* bots.handleMilestone(
        milestone("ask", { threadId: "thread:worker", type: "thread.needs_input" }),
      );
      yield* bots.handleMilestone(milestone("done", { threadId: "thread:worker" }));
      // A watched run's agent step asking wakes the Bot; its turn ending neither wakes nor ends it.
      yield* bots.handleMilestone(
        milestone("step-ask", {
          threadId: "thread:step",
          type: "thread.needs_input",
          stepOf: "run:release",
        }),
      );
      yield* bots.handleMilestone(
        milestone("step-done", { threadId: "thread:step", stepOf: "run:release" }),
      );
      assert.lengthOf(yield* bots.watches(leader.id), 1);
      yield* bots.handleMilestone(milestone("release", { workflowRunId: "run:release" }));
      assert.deepStrictEqual(
        orchestration.sent.map((message) => [message.threadId, message.commandId]),
        [
          [leader.id, "bot-wake:ask:thread:bot"],
          [leader.id, "bot-wake:done:thread:bot"],
          [leader.id, "bot-wake:step-ask:thread:bot"],
          [leader.id, "bot-wake:release:thread:bot"],
        ],
      );
      assert.include(orchestration.sent[0]!.text, "waits for an approval");
      assert.include(orchestration.sent[0]!.text, "do not repeat or relay it");
      // The settled run's watch ended; workers stay watched with no watch at all.
      assert.deepStrictEqual(yield* bots.watches(leader.id), []);

      leader.settledOverride = "settled";
      yield* bots.handleMilestone(milestone("after-settle", { threadId: "thread:worker" }));
      assert.strictEqual(orchestration.sent.length, 4);
    }).pipe(provideBots(orchestration));
  },
);

it.effect(
  "starts a Bot from a thread with a handoff, taking the thread and its workers as workers",
  () => {
    const orchestration = makeOrchestration();
    const source = orchestration.addThread("thread:source", { title: "Fix the flaky test" });
    orchestration.addThread("thread:helper", { groupedUnderThreadId: source.id });
    orchestration.addThread("thread:child", {
      lineage: { parentThreadId: source.id },
    });
    return Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      const { threadId } = yield* bots.start({ threadId: source.id });

      const [launched] = orchestration.launched;
      assert.deepStrictEqual(
        [launched?.threadId, launched?.projectId],
        [threadId, ProjectId.make("project:scratch")],
      );
      assert.include(launched?.text, "Context handoff (full_thread_summary)");
      assert.deepStrictEqual(orchestration.threads.get(threadId)?.botConfig, bot);
      assert.isTrue(yield* bots.isBot(threadId));
      assert.isNull(source.botConfig);
      assert.deepStrictEqual(
        orchestration.dispatched.map((command) => command.threadId),
        [ThreadId.make("thread:helper"), source.id],
      );
      assert.strictEqual(source.groupedUnderThreadId, threadId);

      for (const refused of [threadId, ThreadId.make("thread:child")]) {
        const error = yield* bots.start({ threadId: refused }).pipe(Effect.flip);
        assert.strictEqual(error.reason, "cannot_start");
      }
    }).pipe(provideBots(orchestration));
  },
);

it.effect("creates a Bot outside any project, its instructions saved as its preferences", () => {
  const orchestration = makeOrchestration();
  return Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const { threadId } = yield* bots.create({
      title: "Chief of staff",
      instructions: "  Keep me posted on every project.  ",
      modelSelection: model,
    });

    const [launched] = orchestration.launched;
    assert.deepStrictEqual(
      [launched?.threadId, launched?.projectId],
      [threadId, ProjectId.make("project:scratch")],
    );
    assert.include(launched?.text, "Keep me posted on every project.");
    assert.isTrue(yield* bots.isBot(threadId));
    assert.strictEqual(
      (yield* bots.readFiles({ threadId })).preferences,
      "Keep me posted on every project.\n",
    );
  }).pipe(provideBots(orchestration));
});
