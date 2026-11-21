import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  IssueTrackerKind,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type IssueAutomationRule,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type StandaloneIssueTrackerApi,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Observations from "../persistence/IssueThreadAutomation.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Automation from "./IssueThreadAutomationService.ts";
import { ISSUE_AUTOMATION_WAITS_FOR_IDLE } from "./issueAutomation.ts";
import * as Registry from "./IssueTrackerRegistry.ts";

const LINEAR = IssueTrackerKind.make("linear");
const projectId = ProjectId.make("project:automation");
const threadId = ThreadId.make("thread:automation");
const instant = "2026-11-17T12:00:00.000Z";

function rule(id = "team-a", overrides: Partial<IssueAutomationRule> = {}): IssueAutomationRule {
  return {
    id,
    enabled: true,
    tracker: LINEAR,
    workspace: "acme",
    containerId: id,
    containerName: id,
    mappings: { open: "wake", waiting: "snooze", done: "settle", resolved: "settle" },
    ...overrides,
  };
}

function link(key: string, overrides: Partial<ThreadIssueLink> = {}): ThreadIssueLink {
  return {
    tracker: LINEAR,
    host: "linear.app",
    scope: key.split("-")[0] ?? key,
    key,
    projectId,
    url: `https://linear.app/acme/issue/${key}`,
    displayKey: key,
    title: key,
    source: "manual",
    linkedAt: instant,
    ...overrides,
  };
}

function thread(issues: ReadonlyArray<ThreadIssueLink>): OrchestrationV2AppThread {
  const now = DateTime.makeUnsafe(instant);
  return {
    id: threadId,
    projectId,
    createdBy: "user",
    creationSource: "web",
    title: "Linked work",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    issues,
  };
}

const autoSettleOff = (item: OrchestrationV2AppThread, off: boolean): OrchestrationV2AppThread => ({
  ...item,
  autoSettleDisabledAt: off ? DateTime.makeUnsafe(instant) : null,
});

function setup(
  rules: ReadonlyArray<IssueAutomationRule> = [rule()],
  links: ReadonlyArray<ThreadIssueLink> = [link("ENG-1")],
) {
  const state = {
    revision: 1,
    threads: [thread(links)],
    statuses: new Map<string, ReadonlyArray<{ key: string; stateId: string }>>([
      ["team-a", [{ key: "ENG-1", stateId: "open" }]],
    ]),
    commands: [] as OrchestrationV2ServerCommand[],
    attempts: [] as OrchestrationV2ServerCommand[],
    reads: [] as ReadonlyArray<string>[],
    fail: false,
    busy: false,
    refuseOnce: null as "previously rejected" | "projection error" | null,
    beforeRead: Effect.void as Effect.Effect<void>,
    beforeCatalog: Effect.void as Effect.Effect<void>,
  };
  const tracker: StandaloneIssueTrackerApi = {
    kind: LINEAR,
    capabilities: {
      create: false,
      edit: false,
      comment: false,
      labels: false,
      assignees: false,
      reactions: false,
      templates: false,
      linkedPullRequests: false,
      events: false,
      search: false,
    },
    standalone: {
      tracker: LINEAR,
      displayName: "Linear",
      host: "linear.app",
      scopeNoun: "team",
      credential: { label: "Personal API key", helpUrl: null },
      automationContainer: "team",
    },
    parseIssueUrl: (url) => {
      const [, workspace, , key] = url.pathname.split("/");
      return workspace && key
        ? { host: url.host, workspace, scope: key.split("-")[0] ?? key, key }
        : null;
    },
    probeCredential: () => Effect.die("unused"),
    getViewer: () => Effect.succeed("me"),
    listIssues: () => Effect.succeed({ items: [], nextCursor: null }),
    getIssue: () => Effect.die("unused"),
    getComments: () => Effect.die("unused"),
    automation: {
      listContainers: () => Effect.die("unused"),
      getContainer: (containerId) =>
        state.beforeCatalog.pipe(
          Effect.as({
            workspace: "acme",
            container:
              rules
                .filter((item) => item.containerId === containerId)
                .map((item) => ({ id: item.containerId, name: item.containerName }))[0] ?? null,
          }),
        ),
      listStates: () =>
        Effect.succeed([
          { id: "open", name: "Open" },
          { id: "done", name: "Done" },
        ]),
      readStatuses: (input) =>
        Effect.gen(function* () {
          state.reads.push(input.keys);
          yield* state.beforeRead;
          if (state.fail)
            return yield* new IssueTrackerError({
              tracker: LINEAR,
              operation: "automation",
              reason: "failed",
              detail: "unavailable",
            });
          return state.statuses.get(input.containerId) ?? [];
        }),
    },
  };
  const dependencies = Layer.mergeAll(
    Layer.succeed(Registry.IssueTrackerRegistry, Registry.fromTrackers([tracker])),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getIssueAutomationCandidates: () =>
        Effect.sync(() =>
          state.threads.map((item) => ({ thread: item, revision: state.revision })),
        ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: (command) =>
        Effect.gen(function* () {
          state.attempts.push(command);
          const refusal = state.refuseOnce;
          state.refuseOnce = null;
          if (refusal === "previously rejected")
            return yield* new Orchestrator.OrchestratorCommandPreviouslyRejectedError({
              commandId: command.commandId,
              commandType: command.type,
              detail: "busy before restart",
            });
          if (refusal === "projection error")
            return yield* new Orchestrator.OrchestratorProjectionError({ threadId });
          if (state.busy)
            return yield* new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: ISSUE_AUTOMATION_WAITS_FOR_IDLE,
            });
          state.commands.push(command);
          return { sequence: state.commands.length, storedEvents: [] };
        }),
    }),
    ServerSettings.ServerSettingsService.layerTest({ issueThreadAutomationRules: rules }),
    NodeCrypto.layer,
  );
  const service = Automation.layer.pipe(
    Layer.provideMerge(Observations.layer),
    Layer.provideMerge(dependencies),
  );
  return {
    state,
    // The database outlives the service, so providing the service again is a server restart.
    database: Sqlite.layerMemory,
    service,
    layer: service.pipe(Layer.provideMerge(Sqlite.layerMemory)),
  };
}

const actions = (commands: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  commands.map((command) =>
    command.type === "thread.issue-automation.apply" ? command.action : command.type,
  );

describe("IssueThreadAutomationService", () => {
  it.effect("applies a team's rule to linked issues across projects", () => {
    const { state, layer } = setup();
    const otherThread = ThreadId.make("thread:another");
    const otherProject = ProjectId.make("project:another");
    state.threads.push({
      ...thread([link("ENG-1", { projectId: otherProject })]),
      id: otherThread,
      projectId: otherProject,
    });
    return Effect.gen(function* () {
      const automation = yield* Automation.IssueThreadAutomationService;
      yield* automation.sweep;
      state.statuses.set("team-a", [{ key: "ENG-1", stateId: "done" }]);
      yield* automation.sweep;
      expect(state.commands).toMatchObject([
        { threadId, action: "settle" },
        { threadId: otherThread, action: "settle" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("baselines, keeps manual organization through a restart, and acts on a change", () => {
    const { state, database, service } = setup();
    return Effect.gen(function* () {
      const refreshes = (key: string) =>
        Effect.gen(function* () {
          const automation = yield* Automation.IssueThreadAutomationService;
          return Option.getOrThrow(
            yield* Stream.runHead(automation.subscribeStatusRefreshes({ tracker: LINEAR, key })),
          );
        });
      yield* Effect.gen(function* () {
        const automation = yield* Automation.IssueThreadAutomationService;
        yield* automation.sweep;
        expect(state.commands).toHaveLength(0);
        state.statuses.set("team-a", [{ key: "ENG-1", stateId: "done" }]);
        yield* automation.sweep;
        expect(actions(state.commands)).toEqual(["settle"]);
        expect(yield* refreshes("eng-1")).toBe(1);
        // The user un-settles the thread by hand.
        state.revision++;
        yield* automation.sweep;
      }).pipe(Effect.provide(service));
      yield* Effect.gen(function* () {
        const automation = yield* Automation.IssueThreadAutomationService;
        yield* automation.sweep;
        expect(state.commands).toHaveLength(1);
        state.statuses.set("team-a", [{ key: "ENG-1", stateId: "resolved" }]);
        yield* automation.sweep;
        expect(actions(state.commands)).toEqual(["settle", "settle"]);
        // An open detail refreshes on an unmapped status too; other issues stay at 0.
        state.statuses.set("team-a", [{ key: "ENG-1", stateId: "unmapped" }]);
        yield* automation.sweep;
        expect(state.commands).toHaveLength(2);
        expect(yield* refreshes("ENG-1")).toBe(2);
        expect(yield* refreshes("ENG-2")).toBe(0);
      }).pipe(Effect.provide(service));
    }).pipe(Effect.provide(database));
  });

  it.effect("snoozes when one team's issue waits, and settles once both are done", () => {
    const { state, layer } = setup([rule(), rule("team-b")], [link("ENG-1"), link("OPS-2")]);
    state.statuses.set("team-b", [{ key: "OPS-2", stateId: "waiting" }]);
    return Effect.gen(function* () {
      const automation = yield* Automation.IssueThreadAutomationService;
      yield* automation.sweep;
      state.statuses.set("team-a", [{ key: "ENG-1", stateId: "done" }]);
      yield* automation.sweep;
      state.statuses.set("team-b", [{ key: "OPS-2", stateId: "done" }]);
      yield* automation.sweep;
      // OPS-2 is outside team-a, and ENG-1 outside team-b; neither counts as unread.
      expect(actions(state.commands)).toEqual(["snooze", "settle"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([false, true])(
    "waits for an issue missing from a read, unless the thread was organized meanwhile (%s)",
    (manual) => {
      const { state, layer } = setup([rule()], [link("ENG-1"), link("ENG-2")]);
      state.statuses.set("team-a", [
        { key: "ENG-1", stateId: "open" },
        { key: "ENG-2", stateId: "waiting" },
      ]);
      return Effect.gen(function* () {
        const automation = yield* Automation.IssueThreadAutomationService;
        yield* automation.sweep;
        state.statuses.set("team-a", [{ key: "ENG-1", stateId: "done" }]);
        yield* automation.sweep;
        expect(state.commands).toHaveLength(0);
        if (manual) state.revision++;
        state.statuses.set("team-a", [
          { key: "ENG-1", stateId: "done" },
          { key: "ENG-2", stateId: "waiting" },
        ]);
        yield* automation.sweep;
        expect(state.commands).toMatchObject(
          manual ? [] : [{ action: "snooze", expectedRevision: 1 }],
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("ignores the same issue key in another workspace", () => {
    const { state, layer } = setup(
      [rule()],
      [link("ENG-1", { url: "https://linear.app/another/issue/ENG-1" })],
    );
    const local = ThreadId.make("thread:local");
    return Effect.gen(function* () {
      const automation = yield* Automation.IssueThreadAutomationService;
      yield* automation.sweep;
      expect(state.reads).toEqual([]);
      state.threads.push({ ...thread([link("ENG-1")]), id: local });
      yield* automation.sweep;
      state.statuses.set("team-a", [{ key: "ENG-1", stateId: "done" }]);
      yield* automation.sweep;
      expect(state.reads).toEqual([["ENG-1"], ["ENG-1"]]);
      expect(state.commands).toHaveLength(1);
      expect(state.commands).toMatchObject([{ threadId: local, action: "settle" }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each(["manual organizing", "auto-settle off"] as const)(
    "keeps an action for a busy thread and drops it after %s",
    (change) => {
      const { state, layer } = setup();
      return Effect.gen(function* () {
        const automation = yield* Automation.IssueThreadAutomationService;
        const store = yield* Observations.IssueThreadAutomation;
        yield* automation.sweep;
        state.busy = true;
        state.statuses.set("team-a", [{ key: "ENG-1", stateId: "done" }]);
        yield* automation.sweep;
        const pending = (yield* store.list).get(threadId)?.pending;
        expect(pending?.action).toBe("settle");
        expect(pending?.commandId).not.toBe(state.attempts.at(-1)?.commandId);
        if (change === "manual organizing") state.revision++;
        else state.threads = state.threads.map((item) => autoSettleOff(item, true));
        state.busy = false;
        yield* automation.sweep;
        expect(state.commands).toHaveLength(0);
        expect((yield* store.list).get(threadId)?.pending ?? null).toBeNull();
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect.each([
    { action: "wake", from: "waiting", to: "open" },
    { action: "snooze", from: "open", to: "waiting" },
    { action: "settle", from: "open", to: "done" },
  ] as const)("never applies $action to a thread with auto-settle off", ({ from, to }) => {
    const { state, layer } = setup();
    state.statuses.set("team-a", [{ key: "ENG-1", stateId: from }]);
    return Effect.gen(function* () {
      const automation = yield* Automation.IssueThreadAutomationService;
      yield* automation.sweep;
      state.threads = state.threads.map((item) => autoSettleOff(item, true));
      state.statuses.set("team-a", [{ key: "ENG-1", stateId: to }]);
      yield* automation.sweep;
      // Turned back on, the thread starts from its issues' statuses at that time.
      state.threads = state.threads.map((item) => autoSettleOff(item, false));
      yield* automation.sweep;
      expect(state.attempts).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each(["previously rejected", "projection error"] as const)(
    "retries a %s command with a new id at the same revision",
    (refusal) => {
      const { state, layer } = setup();
      return Effect.gen(function* () {
        const automation = yield* Automation.IssueThreadAutomationService;
        const store = yield* Observations.IssueThreadAutomation;
        yield* automation.sweep;
        state.statuses.set("team-a", [{ key: "ENG-1", stateId: "done" }]);
        state.refuseOnce = refusal;
        yield* automation.sweep;
        const pending = (yield* store.list).get(threadId)?.pending;
        expect(pending?.revision).toBe(1);
        expect(pending?.commandId).not.toBe(state.attempts[0]?.commandId);
        yield* automation.sweep;
        expect(actions(state.commands)).toEqual(["settle"]);
        expect((yield* store.list).get(threadId)?.pending).toBeNull();
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("keeps the last status through a failed read and acts once the read recovers", () => {
    const { state, layer } = setup();
    return Effect.gen(function* () {
      const automation = yield* Automation.IssueThreadAutomationService;
      yield* automation.sweep;
      const checkedAt = (yield* automation.overview).status[0]?.checkedAt;
      state.fail = true;
      state.statuses.set("team-a", [{ key: "ENG-1", stateId: "done" }]);
      yield* automation.sweep;
      expect(state.commands).toHaveLength(0);
      expect((yield* automation.overview).status[0]).toMatchObject({ checkedAt, error: "failed" });
      state.fail = false;
      yield* TestClock.adjust("60 seconds");
      yield* automation.sweep;
      expect(actions(state.commands)).toEqual(["settle"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("saves a rule only for a reachable team, once per team, and in its workspace", () => {
    const { state, layer } = setup();
    return Effect.gen(function* () {
      const automation = yield* Automation.IssueThreadAutomationService;
      expect(
        (yield* automation.catalog({ tracker: LINEAR, containerId: "team-a" })).states,
      ).toMatchObject([{ id: "open" }, { id: "done" }]);
      expect((yield* automation.save({ id: "team-a", rule: rule() })).rules).toHaveLength(1);
      const duplicate = yield* automation
        .save({ id: "duplicate", rule: rule("duplicate", { containerId: "team-a" }) })
        .pipe(Effect.flip);
      expect(duplicate.message).toBe("This team or board already has a rule.");
      const unreachable = yield* automation
        .save({ id: "team-x", rule: rule("team-x") })
        .pipe(Effect.flip);
      expect(unreachable.message).toBe("The connected account cannot reach this team or board.");
      const moved = yield* automation
        .save({ id: "team-a", rule: rule("team-a", { workspace: "another" }) })
        .pipe(Effect.flip);
      expect(moved.message).toBe("The connected account is in another workspace.");
      // Switching a rule off works even when its workspace is no longer reachable.
      const disabled = yield* automation.save({
        id: "team-a",
        rule: rule("team-a", { enabled: false, workspace: "another" }),
      });
      expect(disabled.rules).toMatchObject([{ enabled: false, workspace: "acme" }]);
      // A rule removed while switching it off waited on the tracker stays removed.
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      state.beforeCatalog = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(finish)),
      );
      const switchingOff = yield* automation
        .save({ id: "team-a", rule: rule("team-a", { enabled: false, workspace: "another" }) })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* automation.save({ id: "team-a", rule: null });
      yield* Deferred.succeed(finish, undefined);
      expect((yield* Fiber.join(switchingOff)).rules).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("starts a new baseline when a rule is switched off and on between reads", () => {
    const { state, layer } = setup();
    return Effect.gen(function* () {
      const automation = yield* Automation.IssueThreadAutomationService;
      yield* automation.sweep;
      state.statuses.set("team-a", [{ key: "ENG-1", stateId: "done" }]);
      yield* automation.save({ id: "team-a", rule: rule("team-a", { enabled: false }) });
      yield* automation.save({ id: "team-a", rule: rule() });
      yield* automation.sweep;
      expect(state.commands).toHaveLength(0);
      state.statuses.set("team-a", [{ key: "ENG-1", stateId: "resolved" }]);
      yield* automation.sweep;
      expect(actions(state.commands)).toEqual(["settle"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("drops a decision when its rule is removed during the status read", () => {
    const { state, layer } = setup();
    return Effect.gen(function* () {
      const automation = yield* Automation.IssueThreadAutomationService;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* automation.sweep;
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      state.beforeRead = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(finish)),
      );
      state.statuses.set("team-a", [{ key: "ENG-1", stateId: "done" }]);
      const sweep = yield* automation.sweep.pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* settings.updateSettings({ issueThreadAutomationRules: [] });
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(sweep);
      expect(state.commands).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});
