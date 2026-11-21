import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  IsoDateTime,
  ProviderInstanceId,
  ThreadId,
  type BotId,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { parseGroupMentions, slugifyBotName } from "./BotHome.ts";
import * as BotRepository from "./BotRepository.ts";
import * as BotService from "./BotService.ts";

const decodeThreadId = Schema.decodeUnknownSync(ThreadId);
const decodeProviderInstanceId = Schema.decodeUnknownSync(ProviderInstanceId);
const decodeIsoDateTime = Schema.decodeUnknownSync(IsoDateTime);

interface LaunchedCall {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly prompt: string | undefined;
  readonly modelSelection: ModelSelection;
}

interface SentMessageCall {
  readonly threadId: ThreadId;
  readonly text: string;
}

function makeTestHarness() {
  const launched: Array<LaunchedCall> = [];
  const sentMessages: Array<SentMessageCall> = [];
  const createdProjects: Array<{ readonly projectId: ProjectId; readonly workspaceRoot: string }> =
    [];
  const precheckResponses: Array<{ readonly stdout: string; readonly code: number }> = [];
  let threadCounter = 0;

  const mockProjectService = Layer.mock(ProjectService.ProjectService)({
    create: (input) =>
      Effect.sync(() => {
        createdProjects.push({
          projectId: input.projectId,
          workspaceRoot: input.workspaceRoot,
        });
        return {} as never;
      }),
  });

  const mockThreadLaunch = Layer.mock(ThreadLaunchService.ThreadLaunchService)({
    launch: (input) =>
      Effect.sync(() => {
        threadCounter += 1;
        launched.push({
          projectId: input.projectId,
          title: input.title,
          prompt: input.initialMessage?.text,
          modelSelection: input.modelSelection,
        });
        return {
          threadId: decodeThreadId(`thread-${threadCounter}`),
          projection: {} as never,
          resumed: false,
        };
      }),
  });

  const mockThreadManagement = Layer.mock(ThreadManagementService.ThreadManagementService)({
    sendToThread: (input) =>
      Effect.sync(() => {
        sentMessages.push({ threadId: input.threadId, text: input.text });
        return {} as never;
      }),
  });

  const mockProviderRegistry = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed([
      {
        instanceId: decodeProviderInstanceId("claude-default"),
        enabled: true,
        status: "ready",
        models: [{ slug: "claude-sonnet-4" }],
      } as never,
    ]),
  });

  const mockProcessRunner = Layer.mock(ProcessRunner.ProcessRunner)({
    run: () =>
      Effect.sync(() => {
        const next = precheckResponses.shift() ?? { stdout: "", code: 0 };
        return {
          stdout: next.stdout,
          stderr: "",
          code: next.code as never,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });

  const baseLayer = Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-bots-test-" }),
    SqlitePersistence.layerMemory,
    mockProjectService,
    mockThreadLaunch,
    mockThreadManagement,
    mockProviderRegistry,
    mockProcessRunner,
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

  const layer = BotService.layer.pipe(
    Layer.provideMerge(BotRepository.layer),
    Layer.provideMerge(baseLayer),
  );

  return {
    layer,
    launched,
    sentMessages,
    createdProjects,
    precheckResponses,
  };
}

describe("BotHome pure helpers", () => {
  it("slugifies bot names and parses group mentions", () => {
    expect(slugifyBotName("PR Reviewer!!")).toBe("pr-reviewer");
    expect(slugifyBotName("   ")).toBe("bot");

    const members = [
      { id: "bot-1" as BotId, slug: "pr-reviewer", name: "PR Reviewer" },
      { id: "bot-2" as BotId, slug: "ops-watch", name: "Ops Watch" },
    ];
    expect(parseGroupMentions("hey @pr-reviewer check this", members)).toEqual(["bot-1"]);
    expect(parseGroupMentions("@all please triage", members)).toEqual(["bot-1", "bot-2"]);
    expect(parseGroupMentions("no mentions here", members)).toEqual([]);
  });
});

describe("BotService", () => {
  it.effect("creates bot home files, imports bot folders, and enforces path containment", () => {
    const harness = makeTestHarness();
    return Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;

      const first = yield* bots.create({ name: "PR Reviewer" });
      const second = yield* bots.create({ name: "PR Reviewer" });
      expect(first.slug).toBe("pr-reviewer");
      expect(second.slug).toBe("pr-reviewer-2");
      expect(first.firstRun).toBe(true);
      expect(harness.createdProjects).toHaveLength(2);

      const files = yield* bots.listFiles({ botId: first.id });
      const names = files.files.map((f) => f.relativePath);
      expect(names).toContain("SOUL.md");
      expect(names).toContain("MEMORY.md");
      expect(names).toContain("AGENTS.md");
      expect(names).toContain("CLAUDE.md");

      yield* bots.writeFile({
        botId: first.id,
        relativePath: "memory/2026-11-21.md",
        content: "Remember to check CI logs.",
      });
      const readBack = yield* bots.readFile({
        botId: first.id,
        relativePath: "memory/2026-11-21.md",
      });
      expect(readBack.content).toBe("Remember to check CI logs.");

      const escaped = yield* bots
        .readFile({ botId: first.id, relativePath: "../outside.txt" })
        .pipe(Effect.result);
      expect(Result.isFailure(escaped)).toBe(true);

      const importDir = path.join(config.baseDir, "bot-import-src");
      yield* fs.makeDirectory(path.join(importDir, "skills", "review"), { recursive: true });
      yield* fs.writeFileString(path.join(importDir, "SOUL.md"), "# Imported Reviewer\n");
      yield* fs.writeFileString(
        path.join(importDir, "skills", "review", "SKILL.md"),
        "Run tests before commenting.\n",
      );

      const imported = yield* bots.importFolder({
        sourcePath: importDir,
        name: "Imported Reviewer",
      });
      expect(imported.firstRun).toBe(false);
      const importedSoul = yield* bots.readFile({
        botId: imported.id,
        relativePath: "SOUL.md",
      });
      expect(importedSoul.content).toBe("# Imported Reviewer\n");
      const importedSkill = yield* bots.readFile({
        botId: imported.id,
        relativePath: "skills/review/SKILL.md",
      });
      expect(importedSkill.content).toContain("Run tests before commenting.");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("runs routines with precheck hash deduplication and nightly tidy-up", () => {
    const harness = makeTestHarness();
    return Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      const bot = yield* bots.create({ name: "Ops Watch", tidyUpEnabled: true });

      const initialRoutines = yield* bots.listRoutines({ botId: bot.id });
      expect(initialRoutines.routines.some((r) => r.isTidyUp && r.enabled)).toBe(true);

      const routine = yield* bots.upsertRoutine({
        botId: bot.id,
        title: "Poll open PRs",
        prompt: "Review newly updated PRs.",
        enabled: true,
        schedule: { type: "interval", everyMs: 300_000 },
        precheckCommand: "echo pr-list",
      });

      harness.precheckResponses.push(
        { stdout: "pr-101\n", code: 0 },
        { stdout: "pr-101\n", code: 0 },
        { stdout: "pr-101\npr-102\n", code: 0 },
        { stdout: "err", code: 1 },
      );

      const run1 = yield* bots.runRoutineNow({ routineId: routine.id });
      expect(run1.status).toBe("succeeded");
      expect(run1.threadId).not.toBeNull();

      const run2 = yield* bots.runRoutineNow({ routineId: routine.id });
      expect(run2.status).toBe("skipped_precheck");
      expect(run2.threadId).toBeNull();

      const run3 = yield* bots.runRoutineNow({ routineId: routine.id });
      expect(run3.status).toBe("succeeded");
      expect(run3.threadId).not.toBeNull();

      const run4 = yield* bots.runRoutineNow({ routineId: routine.id });
      expect(run4.status).toBe("skipped_precheck");

      expect(harness.launched).toHaveLength(2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("supports handoffs, multi-bot group mention routing, and stale item sweeps", () => {
    const harness = makeTestHarness();
    return Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      const repo = yield* BotRepository.BotRepository;

      const lead = yield* bots.create({ name: "Eng Lead", itemsStaleDays: 3 });
      const reviewer = yield* bots.create({ name: "PR Reviewer", itemsStaleDays: "never" });

      const chat = yield* bots.openChat({ botId: lead.id });
      expect(chat.bot.firstRun).toBe(false);
      expect(chat.threadId).toBe("thread-1");

      yield* bots.openChat({ botId: lead.id, initialPrompt: "Follow up on issue #42" });
      expect(harness.sentMessages).toHaveLength(1);

      const handoff = yield* bots.handoff({
        fromBotId: lead.id,
        targetBotId: reviewer.id,
        title: "Review PR #99",
        prompt: "Verify tests and diff.",
      });
      expect(handoff.item.source).toBe("handoff");
      expect(handoff.item.status).toBe("in_progress");

      const group = yield* bots.createGroup({
        name: "Delivery Room",
        memberBotIds: [lead.id, reviewer.id],
      });
      const msgResult = yield* bots.sendGroupMessage({
        groupId: group.id,
        body: "@pr-reviewer please inspect the release branch",
      });
      expect(msgResult.dispatchedBotIds).toEqual([reviewer.id]);
      expect(msgResult.threadIds).toHaveLength(1);

      const oldTimestamp = decodeIsoDateTime("2020-01-01T00:00:00.000Z");
      const staleCandidate = yield* bots.createItem({
        botId: lead.id,
        title: "Old ask",
        summary: "Waiting for reply",
      });
      yield* repo.upsertItem({
        ...staleCandidate,
        lastActivityAt: oldTimestamp,
      });

      yield* TestClock.setTime(Date.parse("2026-11-21T00:00:00.000Z"));
      const swept = yield* bots.sweepStaleItems();
      expect(swept).toBe(1);

      const leadItems = yield* bots.listItems({ botId: lead.id, status: "stale" });
      expect(leadItems.items).toHaveLength(1);
      expect(leadItems.items[0]?.id).toBe(staleCandidate.id);
    }).pipe(Effect.provide(harness.layer));
  });
});
