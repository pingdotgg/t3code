import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProviderInstanceId,
  ThreadId,
  type IssueAutomationRule,
  type RuntimeMode,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type StandaloneIssueTrackerApi,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as Automation from "../../../issue/IssueThreadAutomationService.ts";
import * as Registry from "../../../issue/IssueTrackerRegistry.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as IssueRulesHandlers from "./handlers.ts";
import { IssueRulesToolkit } from "./tools.ts";

const LINEAR = IssueTrackerKind.make("linear");
const threadId = ThreadId.make("thread:issue-rules");

const engineering: IssueAutomationRule = {
  id: "rule-engineering",
  enabled: true,
  tracker: LINEAR,
  workspace: "acme",
  containerId: "team-eng",
  containerName: "Engineering",
  mappings: { "state-done": "settle" },
};

function setup(options: { readonly rules?: ReadonlyArray<IssueAutomationRule> } = {}) {
  const thread: { runtimeMode: RuntimeMode } = { runtimeMode: "full-access" };
  const tracker: { connected: boolean; beforeStates: Effect.Effect<void> } = {
    connected: true,
    beforeStates: Effect.void,
  };
  const linear: StandaloneIssueTrackerApi = {
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
    parseIssueUrl: () => null,
    probeCredential: () => Effect.die("unused"),
    getViewer: () => Effect.succeed("me"),
    listIssues: () => Effect.succeed({ items: [], nextCursor: null }),
    getIssue: () => Effect.die("unused"),
    getComments: () => Effect.die("unused"),
    automation: {
      listContainers: () =>
        tracker.connected
          ? Effect.succeed({
              workspace: "acme",
              containers: [
                { id: "team-eng", name: "Engineering" },
                { id: "team-ops", name: "Operations" },
              ],
            })
          : Effect.fail(
              new IssueTrackerError({
                tracker: LINEAR,
                operation: "automation",
                reason: "unauthenticated",
                detail: "Linear rejected the API key.",
              }),
            ),
      listStates: () =>
        tracker.beforeStates.pipe(
          Effect.as([
            { id: "state-progress", name: "In Progress" },
            { id: "state-review", name: "In Review" },
            { id: "state-done", name: "Done" },
          ]),
        ),
      readStatuses: () => Effect.die("unused"),
    },
  };
  const services = Automation.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(Registry.IssueTrackerRegistry, Registry.fromTrackers([linear])),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        Layer.mock(Orchestrator.OrchestratorV2)({}),
        ServerSettings.ServerSettingsService.layerTest({
          issueThreadAutomationRules: options.rules ?? [],
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed(liveThreadShell(id, { runtimeMode: thread.runtimeMode })),
        }),
        Sqlite.layerMemory,
        NodeCrypto.layer,
      ),
    ),
  );
  const layer = McpToolAccess.HandlersLayer.layer(IssueRulesHandlers.layer).pipe(
    Layer.provideMerge(services),
  );
  const caller: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:issue-rules"),
    requestNamespace: "provider:issue-rules",
    thread: {
      threadId,
      providerSessionId: "provider:issue-rules",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration", "issues"]),
    issuedAt: 0,
  };
  const tools = Effect.gen(function* () {
    const toolkit = yield* IssueRulesToolkit;
    return <Name extends keyof typeof IssueRulesToolkit.tools>(
      name: Name,
      params: Parameters<typeof toolkit.handle<Name>>[1],
    ) =>
      toolkit.handle(name, params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map(
          (results) =>
            results.at(-1)!.result as Tool.Success<(typeof IssueRulesToolkit.tools)[Name]>,
        ),
        Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
      );
  });
  const storedRules = ServerSettings.ServerSettingsService.pipe(
    Effect.flatMap((settings) => settings.getSettings),
    Effect.map((settings) => settings.issueThreadAutomationRules),
  );
  return { tracker, thread, layer, tools, storedRules };
}

describe("issue rule toolkit handlers", () => {
  it.effect("lists a tracker's rules and teams, and a team's statuses with their actions", () => {
    const { layer, tools } = setup({ rules: [engineering] });
    return Effect.gen(function* () {
      const call = yield* tools;
      const listed = yield* call("list_issue_status_rules", { tracker: LINEAR });
      expect(listed).toMatchObject({
        rules: [
          {
            id: "rule-engineering",
            containerName: "Engineering",
            mappings: { "state-done": "settle" },
            checkedAt: null,
          },
        ],
        containers: [{ name: "Engineering" }, { name: "Operations" }],
        statuses: [],
      });
      expect(
        (yield* call("list_issue_status_rules", { tracker: LINEAR, containerId: "team-eng" }))
          .statuses,
      ).toEqual([
        { id: "state-progress", name: "In Progress", action: null },
        { id: "state-review", name: "In Review", action: null },
        { id: "state-done", name: "Done", action: "settle" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("creates a rule from status names, changes and disables it, then removes it", () => {
    const { layer, tools, storedRules } = setup();
    return Effect.gen(function* () {
      const call = yield* tools;
      const created = yield* call("set_issue_status_rule", {
        tracker: LINEAR,
        containerId: "team-ops",
        statuses: { "in review": "snooze", Done: "settle" },
      });
      expect(created.statuses.map((status) => status.action)).toEqual([null, "snooze", "settle"]);
      const [stored] = yield* storedRules;
      expect(stored).toMatchObject({
        enabled: true,
        workspace: "acme",
        containerId: "team-ops",
        containerName: "Operations",
        mappings: { "state-review": "snooze", "state-done": "settle" },
      });

      yield* call("set_issue_status_rule", {
        tracker: LINEAR,
        containerId: "team-ops",
        statuses: { "In Review": null, "In Progress": "wake" },
        enabled: false,
      });
      expect(yield* storedRules).toMatchObject([
        {
          id: stored!.id,
          enabled: false,
          mappings: { "state-progress": "wake", "state-done": "settle" },
        },
      ]);
      expect(Object.keys((yield* storedRules)[0]!.mappings)).not.toContain("state-review");

      const removed = yield* call("set_issue_status_rule", {
        tracker: LINEAR,
        containerId: "team-ops",
        remove: true,
      });
      expect(removed.rules).toEqual([]);
      expect(yield* storedRules).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "keeps an unchanged rule's baseline and refuses a status the team does not have",
    () => {
      const { layer, tools, storedRules } = setup({ rules: [engineering] });
      return Effect.gen(function* () {
        const call = yield* tools;
        yield* call("set_issue_status_rule", {
          tracker: LINEAR,
          containerId: "team-eng",
          statuses: { Done: "settle" },
        });
        expect((yield* storedRules)[0]?.generation).toBeUndefined();

        const error = yield* call("set_issue_status_rule", {
          tracker: LINEAR,
          containerId: "team-eng",
          statuses: { Shipped: "settle" },
        }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "IssueAutomationError" });
        expect(error.message).toContain("In Progress, In Review, Done");
        expect(yield* storedRules).toEqual([engineering]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("keeps both of two overlapping edits to one rule", () => {
    const { tracker, layer, tools, storedRules } = setup({ rules: [engineering] });
    return Effect.gen(function* () {
      const call = yield* tools;
      // Tracker reads finish in pairs, so the two edits keep pace until they write.
      const pairs: Array<Latch.Latch> = [];
      let reads = 0;
      tracker.beforeStates = Effect.gen(function* () {
        const pair = Math.floor(reads++ / 2);
        const latch = (pairs[pair] ??= yield* Latch.make());
        if (reads % 2 === 0) yield* latch.open;
        yield* latch.await;
      });
      yield* Effect.all(
        [
          call("set_issue_status_rule", {
            tracker: LINEAR,
            containerId: "team-eng",
            statuses: { "In Review": "snooze" },
          }),
          call("set_issue_status_rule", {
            tracker: LINEAR,
            containerId: "team-eng",
            statuses: { "In Progress": "wake" },
          }),
        ],
        { concurrency: "unbounded" },
      );
      expect((yield* storedRules)[0]?.mappings).toEqual({
        "state-done": "settle",
        "state-review": "snooze",
        "state-progress": "wake",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "switches off a rule the tracker cannot reach, but does not change its statuses",
    () => {
      const { tracker, layer, tools, storedRules } = setup({ rules: [engineering] });
      tracker.connected = false;
      return Effect.gen(function* () {
        const call = yield* tools;
        const listed = yield* call("list_issue_status_rules", { tracker: LINEAR });
        expect(listed).toMatchObject({ rules: [{ id: "rule-engineering" }], containers: [] });
        expect(listed.error).toContain("Linear rejected the API key.");

        const changed = yield* call("set_issue_status_rule", {
          tracker: LINEAR,
          containerId: "team-eng",
          statuses: { Done: null },
        }).pipe(Effect.flip);
        expect(changed).toMatchObject({ _tag: "IssueAutomationError" });

        yield* call("set_issue_status_rule", {
          tracker: LINEAR,
          containerId: "team-eng",
          enabled: false,
        });
        expect(yield* storedRules).toMatchObject([
          { id: "rule-engineering", enabled: false, mappings: { "state-done": "settle" } },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("refuses a write from a caller that may not change environment settings", () => {
    const { tracker, thread, layer, tools, storedRules } = setup();
    return Effect.gen(function* () {
      const call = yield* tools;
      const write = call("set_issue_status_rule", {
        tracker: LINEAR,
        containerId: "team-eng",
        statuses: { Done: "settle" },
      }).pipe(Effect.flip);
      // The caller leaves Full access while the tracker read is in flight.
      tracker.beforeStates = Effect.sync(() => {
        thread.runtimeMode = "approval-required";
      });
      for (const error of [yield* write, yield* write]) {
        expect(error).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "capability_denied" });
        expect(error.message).toContain("full-access");
      }
      expect(yield* storedRules).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});
