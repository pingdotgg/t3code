import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  PullRequestMonitorId,
  ThreadId,
  type PullRequestMonitorRecord,
  type PullRequestMonitorContextInput,
  type PullRequestMonitorReportInput,
  type PullRequestMonitorSubmitFindingsInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { Tool } from "effect/unstable/ai";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PullRequestMonitorService } from "../../../pullRequestMonitor/PullRequestMonitorService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { PullRequestMonitorToolkitHandlersLive } from "./handlers.ts";
import {
  PullRequestMonitorContextTool,
  PullRequestMonitorReportTool,
  PullRequestMonitorSubmitFindingsTool,
  PullRequestMonitorToolkit,
} from "./tools.ts";

const projectId = ProjectId.make("proj_mcp");
const callerThreadId = ThreadId.make("thr_caller");
const otherThreadId = ThreadId.make("thr_other");

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("env_1"),
  threadId: callerThreadId,
  providerSessionId: "session-1",
  providerInstanceId: ProviderInstanceId.make("copilot"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

const monitor = (overrides: Partial<PullRequestMonitorRecord> = {}): PullRequestMonitorRecord => ({
  id: PullRequestMonitorId.make("mon_1"),
  canonicalKey: "github|github.com|acme/app|12",
  provider: "github",
  host: "github.com",
  repository: "acme/app",
  number: 12,
  projectId,
  ownerThreadId: callerThreadId,
  linkedReviewThreadId: null,
  status: "monitoring",
  enabled: true,
  readiness: null,
  headSha: "head-1",
  sourceRevision: "rev-1",
  lastPolledAt: null,
  nextPollAt: null,
  lastError: null,
  pollFailureCount: 0,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  stoppedAt: null,
  ...overrides,
});

const fakeProjections = {
  getThreadShellById: (threadId: ThreadId) =>
    Effect.succeed(
      threadId === callerThreadId
        ? Option.some({ id: threadId, projectId } as never)
        : Option.none(),
    ),
} as unknown as ProjectionSnapshotQuery["Service"];

const makeLayer = (input: {
  readonly onContext?: (input: PullRequestMonitorContextInput) => void;
  readonly monitorRecord?: PullRequestMonitorRecord;
  readonly onReport?: (input: PullRequestMonitorReportInput) => void;
  readonly onSubmitFindings?: (input: PullRequestMonitorSubmitFindingsInput) => void;
}) => {
  const record = input.monitorRecord ?? monitor();
  const fakeMonitors = PullRequestMonitorService.of({
    start: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    status: () => Effect.die("unused"),
    automationDeliveryState: () => Effect.succeed("blocked"),
    list: () => Effect.die("unused"),
    subscribeList: () => Stream.empty,
    pollOnce: Effect.void,
    context: (contextInput) =>
      Effect.sync(() => {
        input.onContext?.(contextInput);
        return {
          monitor: record,
          latestSnapshot: null,
          items: [],
          recentDeliveries: [],
          recentReports: [],
        };
      }),
    report: (reportInput) =>
      Effect.sync(() => {
        input.onReport?.(reportInput);
        return {
          item: {
            id: reportInput.itemId,
            monitorId: record.id,
            stableKey: "check-failed:ci",
            kind: "check-failed" as const,
            status: "verifying" as const,
            disposition: "resolved" as const,
            dispositionNote: null,
            dispositionAt: "2026-08-11T00:00:00.000Z",
            dispositionByThreadId: reportInput.reporterThreadId ?? null,
            firstSeenAt: "2026-08-11T00:00:00.000Z",
            lastSeenAt: "2026-08-11T00:00:00.000Z",
            currentRevisionId: null,
            currentRevisionHeadSha: null,
            summary: "check-failed: ci",
          },
          report: {
            id: "fb_report_1",
            monitorId: record.id,
            itemId: reportInput.itemId,
            disposition: reportInput.disposition,
            note: reportInput.note ?? null,
            reporterThreadId: reportInput.reporterThreadId ?? null,
            createdAt: "2026-08-11T00:00:00.000Z",
          },
          recheckRequested: true,
          awaitingVerification: true,
        };
      }),
    transferOwnership: () => Effect.die("unused"),
    submitFindings: (submitInput) =>
      Effect.sync(() => {
        input.onSubmitFindings?.(submitInput);
        return {
          monitor: record,
          linkedReviewThreadId: submitInput.reviewThreadId,
          ownerThreadId: record.ownerThreadId,
          monitoringStarted: true,
          findings: [],
        };
      }),
    launchFallback: () => Effect.die("unused"),
  });

  return PullRequestMonitorToolkitHandlersLive.pipe(
    Layer.provideMerge(Layer.succeed(PullRequestMonitorService, fakeMonitors)),
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, fakeProjections)),
  );
};

const callTool = (name: string, payload: unknown) =>
  Effect.gen(function* () {
    const toolkit = yield* PullRequestMonitorToolkit;
    return yield* toolkit
      .handle(name as never, payload as never)
      .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption));
  }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, invocation));

it.effect("derives the reporter thread from the credential, never from arguments", () =>
  Effect.gen(function* () {
    const seen: PullRequestMonitorReportInput[] = [];
    yield* callTool("pr_monitor_report", {
      itemId: "fb_item_1",
      disposition: "resolved",
      note: "fixed",
      // A hostile argument that must be ignored: identity comes from the credential.
      reporterThreadId: otherThreadId,
      repository: "acme/app",
      number: 12,
    }).pipe(Effect.provide(makeLayer({ onReport: (value) => seen.push(value) })));

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0]?.reporterThreadId, callerThreadId);
    assert.strictEqual(seen[0]?.reference?.projectId, projectId);
  }),
);

it.effect("refuses a chat that neither owns nor reviews the monitor", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      callTool("pr_monitor_report", {
        itemId: "fb_item_1",
        disposition: "accepted",
      }).pipe(
        Effect.provide(makeLayer({ monitorRecord: monitor({ ownerThreadId: otherThreadId }) })),
      ),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("allows the linked review chat to read monitor context", () =>
  Effect.gen(function* () {
    const context = yield* callTool("pr_monitor_context", {
      repository: "acme/app",
      number: 12,
    }).pipe(
      Effect.provide(
        makeLayer({
          monitorRecord: monitor({
            ownerThreadId: otherThreadId,
            linkedReviewThreadId: callerThreadId,
          }),
        }),
      ),
    );

    assert.isDefined(context);
  }),
);

it.effect("forwards exact delivery pagination with server-derived project identity", () =>
  Effect.gen(function* () {
    const seen: PullRequestMonitorContextInput[] = [];
    yield* callTool("pr_monitor_context", {
      repository: "acme/app",
      number: 12,
      deliveryId: "delivery-1",
      offset: 10,
      limit: 5,
    }).pipe(Effect.provide(makeLayer({ onContext: (input) => seen.push(input) })));
    assert.strictEqual(seen[0]?.deliveryId, "delivery-1");
    assert.strictEqual(seen[0]?.offset, 10);
    assert.strictEqual(seen[0]?.limit, 5);
    assert.strictEqual(seen[0]?.reference?.projectId, projectId);
  }),
);
it.effect("submits findings as the authenticated review chat", () =>
  Effect.gen(function* () {
    const seen: PullRequestMonitorSubmitFindingsInput[] = [];
    yield* callTool("pr_monitor_submit_findings", {
      repository: "acme/app",
      number: 12,
      findings: [
        {
          title: "Unbounded query",
          detail: "Add a limit.",
          severity: "major",
          path: "src/a.ts",
          line: 3,
        },
      ],
      summary: "one finding",
    }).pipe(Effect.provide(makeLayer({ onSubmitFindings: (value) => seen.push(value) })));

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0]?.reviewThreadId, callerThreadId);
    assert.strictEqual(seen[0]?.reference.projectId, projectId);
    assert.strictEqual(seen[0]?.findings?.length, 1);
    assert.strictEqual(seen[0]?.findings?.[0]?.severity, "major");
  }),
);

it.effect("rejects a caller whose chat no longer exists", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      Effect.gen(function* () {
        const toolkit = yield* PullRequestMonitorToolkit;
        return yield* toolkit
          .handle("pr_monitor_context" as never, {} as never)
          .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption));
      }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...invocation,
          threadId: otherThreadId,
        }),
        Effect.provide(makeLayer({})),
      ),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("never accepts a project or thread id in a tool schema", () =>
  Effect.sync(() => {
    for (const tool of [
      PullRequestMonitorContextTool,
      PullRequestMonitorReportTool,
      PullRequestMonitorSubmitFindingsTool,
    ]) {
      const schema = JSON.stringify(Tool.getJsonSchema(tool));
      assert.notInclude(schema, "projectId");
      assert.notInclude(schema, "reviewThreadId");
      assert.notInclude(schema, "ownerThreadId");
    }
  }),
);
