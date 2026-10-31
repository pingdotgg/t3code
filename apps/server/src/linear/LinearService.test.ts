import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type PipelineRun,
  ThreadId as ThreadIdSchema,
  type LinearRecordLaunchInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PipelineService from "../pipelines/PipelineService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { computeLinearActivity } from "./LinearActivity.ts";
import * as LinearLinkStore from "./LinearLinkStore.ts";
import * as LinearService from "./LinearService.ts";

const KEY = "lin_api_super_secret_key";

type Handler = (operation: string, variables: Record<string, unknown>) => Response | "network";

interface Harness {
  readonly calls: Array<{ operation: string; authorization: string | undefined }>;
  handler: Handler;
  run: PipelineRun;
}

const operationOf = (query: string) => /(?:query|mutation)\s+(\w+)/u.exec(query)?.[1] ?? "unknown";
const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);

const issueNode = (stateType = "unstarted") => ({
  id: "issue-1",
  identifier: "ATT-612",
  title: "Ship it",
  url: "https://linear.app/acme/issue/ATT-612",
  priority: 2,
  priorityLabel: "High",
  branchName: "att-612",
  updatedAt: "2026-10-30T10:00:00.000Z",
  state: { id: "state-todo", name: "Todo", type: stateType, color: "#ccc" },
  assignee: null,
  labels: { nodes: [] },
  cycle: null,
  projectMilestone: null,
  project: { id: "project-1", name: "Launch" },
  team: { id: "team-1", key: "ATT", name: "Attio" },
  parent: null,
  children: { nodes: [] },
  attachments: { nodes: [] },
});

const okHandler =
  (stateType = "unstarted"): Handler =>
  (operation) => {
    switch (operation) {
      case "Viewer":
        return json({
          data: {
            viewer: { id: "u1", name: "Ada", email: "ada@example.com", avatarUrl: null },
            organization: { id: "o1", name: "Acme", urlKey: "acme" },
          },
        });
      case "Teams":
        return json({
          data: {
            teams: {
              nodes: [
                {
                  id: "team-1",
                  key: "ATT",
                  name: "Attio",
                  description: null,
                  color: null,
                  icon: null,
                  projects: { nodes: [] },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      case "AssignedIssues":
        return json({ data: { viewer: { assignedIssues: { nodes: [] } } } });
      case "Issues":
        return json({
          data: {
            issues: {
              nodes: [issueNode(stateType)],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      case "Issue":
        return json({ data: { issue: issueNode(stateType) } });
      case "MoveIssue":
        return json({ data: { issueUpdate: { success: true } } });
      case "CreateComment":
        return json({ data: { commentCreate: { success: true, comment: { id: "comment-1" } } } });
      case "UpdateComment":
        return json({ data: { commentUpdate: { success: true } } });
      default:
        return json({ errors: [{ message: "unexpected" }] }, { status: 500 });
    }
  };

const pipelineRun = (status: PipelineRun["status"], stepStatus: string): PipelineRun =>
  ({
    id: "run-1",
    status,
    pauseReason: null,
    currentStepIndex: 0,
    updatedAt: "2026-10-30T10:00:00.000Z",
    definition: { name: "Feature delivery", steps: [{ id: "plan", name: "Plan" }] },
    steps: [{ stepId: "plan", status: stepStatus }],
  }) as unknown as PipelineRun;

const makeHarness = (): Harness => ({
  calls: [],
  handler: okHandler(),
  run: pipelineRun("running", "running"),
});

const makeLayer = (harness: Harness) => {
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const raw =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
      const body = JSON.parse(raw) as { query: string; variables: Record<string, unknown> };
      const operation = operationOf(body.query);
      harness.calls.push({ operation, authorization: request.headers.authorization });
      const result = harness.handler(operation, body.variables);
      return result === "network"
        ? Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            }),
          )
        : Effect.succeed(HttpClientResponse.fromWeb(request, result));
    }),
  );
  const settings = ServerSettings.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-linear-test-" })),
    ),
  );
  const pipelines = Layer.mock(PipelineService.PipelineService)({
    getRun: () => Effect.succeed(harness.run),
  });
  const projection = Layer.mock(ProjectionStore.ProjectionStoreV2)({});
  return LinearService.layer.pipe(
    Layer.provideMerge(LinearLinkStore.layer),
    Layer.provideMerge(settings),
    Layer.provide(Layer.mergeAll(http, pipelines, projection, NodeCrypto.layer)),
    Layer.provideMerge(NodeServices.layer),
  );
};

const threadId = ThreadIdSchema.make("thread-1");
const launchInput = (
  overrides: Partial<LinearRecordLaunchInput> = {},
): LinearRecordLaunchInput => ({
  issueId: "issue-1",
  target: { kind: "thread", targetId: threadId, threadId, title: "Fix ATT-612" },
  writeBack: { moveToStateId: "state-progress", comment: true },
  threadUrl: "https://t3.example/env/thread-1",
  ...overrides,
});

const count = (harness: Harness, operation: string) =>
  harness.calls.filter((call) => call.operation === operation).length;

describe("LinearService", () => {
  it.effect("verifies a key, stores it, and never exposes it to clients", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const linear = yield* LinearService.LinearService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;

      const before = yield* linear.status;
      assert.strictEqual(before.state, "disconnected");

      const status = yield* linear.connect({ apiKey: KEY });
      assert.strictEqual(status.state, "connected");
      assert.strictEqual(status.organization?.urlKey, "acme");
      assert.strictEqual(status.teams[0]?.key, "ATT");
      assert.isTrue(harness.calls.every((call) => call.authorization === KEY));
      assert.notInclude(JSON.stringify(status), KEY);

      const stored = yield* settings.getSettings;
      assert.strictEqual(stored.linear.apiKey, KEY);
      const client = ServerSettings.redactServerSettingsForClient(stored);
      assert.notInclude(JSON.stringify(client), KEY);
      assert.notInclude(yield* fs.readFileString(config.settingsPath), KEY);

      // Echoing the redacted snapshot back must keep the stored key.
      yield* settings.updateSettings({
        linear: { apiKey: client.linear.apiKey, commentEnabled: true },
      });
      const after = yield* settings.getSettings;
      assert.strictEqual(after.linear.apiKey, KEY);
      assert.isTrue(after.linear.commentEnabled);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("stores nothing when Linear rejects or cannot be reached", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const linear = yield* LinearService.LinearService;
      const settings = yield* ServerSettings.ServerSettingsService;

      harness.handler = () => json({ errors: [{ message: "nope" }] }, { status: 401 });
      const rejected = yield* Effect.flip(linear.connect({ apiKey: KEY }));
      assert.strictEqual(rejected.reason, "unauthorized");
      assert.strictEqual(rejected.message, "Linear rejected this key.");
      assert.notInclude(JSON.stringify(rejected), KEY);

      harness.handler = () => "network";
      const unreachable = yield* Effect.flip(linear.connect({ apiKey: KEY }));
      assert.strictEqual(unreachable.reason, "unavailable");
      assert.strictEqual(unreachable.message, "Couldn't reach Linear.");

      assert.strictEqual((yield* settings.getSettings).linear.apiKey, "");
      assert.strictEqual((yield* linear.status).state, "disconnected");
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("turns a 401 into status invalid, keeps the key, and stops calling Linear", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const linear = yield* LinearService.LinearService;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* linear.connect({ apiKey: KEY });

      harness.handler = () => json({ errors: [{ message: "revoked" }] }, { status: 401 });
      const error = yield* Effect.flip(linear.issues({}));
      assert.strictEqual(error.reason, "unauthorized");
      const callsAfterRejection = harness.calls.length;

      assert.strictEqual((yield* linear.status).state, "invalid");
      assert.strictEqual((yield* Effect.flip(linear.teams)).reason, "unauthorized");
      assert.strictEqual(harness.calls.length, callsAfterRejection);
      assert.strictEqual((yield* settings.getSettings).linear.apiKey, KEY);

      // Replacing the key recovers without a manual reset.
      harness.handler = okHandler();
      yield* linear.connect({ apiKey: "lin_api_replacement" });
      assert.strictEqual((yield* linear.status).state, "connected");
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("disconnect removes the key but keeps links", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const linear = yield* LinearService.LinearService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const store = yield* LinearLinkStore.LinearLinkStore;
      yield* linear.connect({ apiKey: KEY });
      yield* linear.recordLaunch(launchInput({ writeBack: { comment: false } }));

      const status = yield* linear.disconnect;
      assert.strictEqual(status.state, "disconnected");
      assert.strictEqual((yield* settings.getSettings).linear.apiKey, "");
      assert.strictEqual((yield* store.list(10)).length, 1);
      assert.strictEqual((yield* Effect.flip(linear.issues({}))).reason, "not_connected");
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect(
    "serves stale data while rate limited and stops calling until the window passes",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const linear = yield* LinearService.LinearService;
        yield* linear.connect({ apiKey: KEY });
        const fresh = yield* linear.issues({ teamId: "team-1" });
        assert.isFalse(fresh.stale);
        assert.strictEqual(fresh.issues.length, 1);
        assert.strictEqual((yield* linear.issues({ teamId: "team-1" })).stale, false);
        assert.strictEqual(count(harness, "Issues"), 1);

        yield* TestClock.adjust("2 minutes");
        harness.handler = () =>
          json(
            { errors: [{ message: "slow", extensions: { code: "RATELIMITED" } }] },
            { status: 400, headers: { "retry-after": "120" } },
          );
        const stale = yield* linear.issues({ teamId: "team-1" });
        assert.isTrue(stale.stale);
        assert.strictEqual(stale.issues[0]?.identifier, "ATT-612");
        const callsDuringLimit = harness.calls.length;

        const again = yield* linear.issues({ teamId: "team-1" });
        assert.isTrue(again.stale);
        assert.strictEqual(harness.calls.length, callsDuringLimit);
        assert.isNotNull((yield* linear.status).rateLimitedUntil);

        // Uncached reads fail with a retry hint instead of hitting Linear.
        const uncached = yield* Effect.flip(linear.issueDetail("other"));
        assert.strictEqual(uncached.reason, "rate_limited");
        assert.isAbove(uncached.retryAfterSeconds ?? 0, 0);

        yield* TestClock.adjust("3 minutes");
        harness.handler = okHandler();
        const recovered = yield* linear.issues({ teamId: "team-1" });
        assert.isFalse(recovered.stale);
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect("serves stale data during an outage and backs off exponentially", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const linear = yield* LinearService.LinearService;
      yield* linear.connect({ apiKey: KEY });
      yield* linear.issues({});
      yield* TestClock.adjust("2 minutes");

      harness.handler = () => "network";
      assert.isTrue((yield* linear.issues({})).stale);
      const afterFirstFailure = harness.calls.length;
      assert.isTrue((yield* linear.issues({})).stale);
      assert.strictEqual(harness.calls.length, afterFirstFailure);

      yield* TestClock.adjust("6 seconds");
      assert.isTrue((yield* linear.issues({})).stale);
      assert.isAbove(harness.calls.length, afterFirstFailure);

      // A manual refresh forgets the backoff.
      const beforeRefresh = harness.calls.length;
      yield* linear.refresh;
      assert.isTrue((yield* linear.issues({})).stale);
      assert.isAbove(harness.calls.length, beforeRefresh);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("surfaces a rejected request without backing off or serving stale data", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const linear = yield* LinearService.LinearService;
      yield* linear.connect({ apiKey: KEY });
      yield* linear.issues({});
      yield* TestClock.adjust("2 minutes");

      harness.handler = () =>
        json(
          { errors: [{ message: "no", extensions: { code: "FORBIDDEN", type: "forbidden" } }] },
          { status: 400 },
        );
      assert.strictEqual((yield* Effect.flip(linear.issues({}))).reason, "invalid_input");
      const afterFirst = count(harness, "Issues");
      assert.strictEqual((yield* Effect.flip(linear.issues({}))).reason, "invalid_input");
      assert.strictEqual(count(harness, "Issues"), afterFirst + 1);

      harness.handler = okHandler();
      assert.strictEqual((yield* linear.status).state, "connected");
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("a manual refresh re-reads the team cards and their counts", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const linear = yield* LinearService.LinearService;
      yield* linear.connect({ apiKey: KEY });
      yield* linear.teams;
      yield* linear.teams;
      assert.strictEqual(count(harness, "Teams"), 1);
      yield* linear.refresh;
      yield* linear.teams;
      assert.strictEqual(count(harness, "Teams"), 2);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("deduplicates concurrent identical reads", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const linear = yield* LinearService.LinearService;
      yield* linear.connect({ apiKey: KEY });
      yield* Effect.all([linear.issues({}), linear.issues({}), linear.issues({})], {
        concurrency: "unbounded",
      });
      assert.strictEqual(count(harness, "Issues"), 1);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  describe("recordLaunch", () => {
    it.effect("links the thread, moves the state and comments exactly once", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const linear = yield* LinearService.LinearService;
        yield* linear.connect({ apiKey: KEY });

        const first = yield* linear.recordLaunch(launchInput());
        assert.deepStrictEqual(first.warnings, []);
        assert.strictEqual(first.link.issueIdentifier, "ATT-612");
        assert.strictEqual(first.link.teamId, "team-1");
        assert.strictEqual(first.link.projectId, "project-1");
        assert.strictEqual(first.link.stateMovedTo, "state-progress");
        assert.strictEqual(first.link.commentId, "comment-1");
        assert.strictEqual(first.link.commentMode, "thread");
        assert.strictEqual(count(harness, "MoveIssue"), 1);
        assert.strictEqual(count(harness, "CreateComment"), 1);

        const second = yield* linear.recordLaunch(launchInput());
        assert.strictEqual(second.link.linkId, first.link.linkId);
        assert.strictEqual(count(harness, "MoveIssue"), 1);
        assert.strictEqual(count(harness, "CreateComment"), 1);
      }).pipe(Effect.provide(makeLayer(harness)));
    });

    it.effect("moves and comments once when the same launch is recorded concurrently", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const linear = yield* LinearService.LinearService;
        yield* linear.connect({ apiKey: KEY });
        const [first, second] = yield* Effect.all(
          [linear.recordLaunch(launchInput()), linear.recordLaunch(launchInput())],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(first.link.linkId, second.link.linkId);
        assert.strictEqual(count(harness, "MoveIssue"), 1);
        assert.strictEqual(count(harness, "CreateComment"), 1);
      }).pipe(Effect.provide(makeLayer(harness)));
    });

    it.effect("only moves issues that have not started", () => {
      const harness = makeHarness();
      harness.handler = okHandler("started");
      return Effect.gen(function* () {
        const linear = yield* LinearService.LinearService;
        yield* linear.connect({ apiKey: KEY });
        const result = yield* linear.recordLaunch(launchInput());
        assert.strictEqual(count(harness, "MoveIssue"), 0);
        assert.strictEqual(result.link.stateMovedTo, null);
      }).pipe(Effect.provide(makeLayer(harness)));
    });

    it.effect("reports failed write-backs as warnings without failing the launch", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const linear = yield* LinearService.LinearService;
        yield* linear.connect({ apiKey: KEY });
        const base = okHandler();
        harness.handler = (operation, variables) =>
          operation === "MoveIssue" || operation === "CreateComment"
            ? new Response("down", { status: 503 })
            : base(operation, variables);

        const result = yield* linear.recordLaunch(launchInput());
        assert.deepStrictEqual(result.warnings.map((warning) => warning.step).toSorted(), [
          "comment",
          "move_state",
        ]);
        assert.strictEqual(result.link.commentId, null);
        assert.strictEqual(result.link.stateMovedTo, null);

        // The next call retries what failed instead of duplicating what worked.
        harness.handler = base;
        yield* TestClock.adjust("1 minute");
        const retry = yield* linear.recordLaunch(launchInput());
        assert.deepStrictEqual(retry.warnings, []);
        assert.strictEqual(retry.link.commentId, "comment-1");
        assert.strictEqual(retry.link.stateMovedTo, "state-progress");
      }).pipe(Effect.provide(makeLayer(harness)));
    });

    it.effect("still links the launch, without write-back, when Linear cannot be read", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const linear = yield* LinearService.LinearService;
        const store = yield* LinearLinkStore.LinearLinkStore;
        const result = yield* linear.recordLaunch(
          launchInput({ issue: { identifier: "ATT-612", teamId: "team-1" } }),
        );
        assert.strictEqual(result.link.issueIdentifier, "ATT-612");
        assert.strictEqual(result.link.commentId, null);
        assert.strictEqual(result.link.stateMovedTo, null);
        assert.deepStrictEqual(result.warnings, []);
        assert.strictEqual((yield* store.list(10)).length, 1);
        assert.strictEqual(harness.calls.length, 0);
      }).pipe(Effect.provide(makeLayer(harness)));
    });

    it.effect(
      "links the launch when Linear rejects the read, and warns when Linear is down",
      () => {
        const harness = makeHarness();
        return Effect.gen(function* () {
          const linear = yield* LinearService.LinearService;
          yield* linear.connect({ apiKey: KEY });
          harness.handler = () =>
            json(
              { errors: [{ message: "no", extensions: { code: "FORBIDDEN", type: "forbidden" } }] },
              { status: 400 },
            );
          const rejected = yield* linear.recordLaunch(
            launchInput({ issueId: "issue-3", issue: { identifier: "ATT-614", teamId: "team-1" } }),
          );
          assert.strictEqual(rejected.link.issueIdentifier, "ATT-614");
          assert.strictEqual(rejected.link.commentMode, "none");

          harness.handler = () => "network";
          const result = yield* linear.recordLaunch(
            launchInput({ issueId: "issue-2", issue: { identifier: "ATT-613", teamId: "team-1" } }),
          );
          assert.strictEqual(result.link.issueIdentifier, "ATT-613");
          assert.deepStrictEqual(result.warnings.map((warning) => warning.step).toSorted(), [
            "comment",
            "move_state",
          ]);
        }).pipe(Effect.provide(makeLayer(harness)));
      },
    );

    it.effect("fails with not_connected rather than recording an unverifiable link", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const linear = yield* LinearService.LinearService;
        const store = yield* LinearLinkStore.LinearLinkStore;
        const error = yield* Effect.flip(linear.recordLaunch(launchInput()));
        assert.strictEqual(error.reason, "not_connected");
        assert.strictEqual((yield* store.list(10)).length, 0);
      }).pipe(Effect.provide(makeLayer(harness)));
    });

    it.effect("posts one pipeline comment and edits it as the run changes", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const linear = yield* LinearService.LinearService;
        const store = yield* LinearLinkStore.LinearLinkStore;
        yield* linear.connect({ apiKey: KEY });
        const bodies: string[] = [];
        const base = okHandler();
        harness.handler = (operation, variables) => {
          if (operation === "CreateComment" || operation === "UpdateComment") {
            bodies.push(String(variables.body));
          }
          return base(operation, variables);
        };

        const launched = yield* linear.recordLaunch(
          launchInput({
            target: {
              kind: "pipeline_run",
              targetId: "run-1",
              threadId,
              title: "Feature delivery",
            },
            writeBack: { comment: true },
          }),
        );
        assert.strictEqual(launched.link.commentMode, "pipeline");
        assert.strictEqual(launched.link.commentId, "comment-1");
        assert.strictEqual(count(harness, "CreateComment"), 1);
        assert.include(bodies[0], "Running: Plan");
        assert.include(bodies[0], "https://t3.example/env/thread-1");

        const stored = (yield* store.get(launched.link.linkId))!;
        yield* linear.syncPipelineComment(stored);
        assert.strictEqual(count(harness, "UpdateComment"), 0);

        harness.run = pipelineRun("completed", "completed");
        yield* linear.syncPipelineComment(stored);
        assert.strictEqual(count(harness, "UpdateComment"), 1);
        assert.include(bodies[1], "Completed");

        yield* linear.syncPipelineComment(stored);
        assert.strictEqual(count(harness, "UpdateComment"), 1);
        assert.strictEqual(count(harness, "CreateComment"), 1);
      }).pipe(Effect.provide(makeLayer(harness)));
    });

    it.effect("never comments on a pipeline launched without the comment toggle", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const linear = yield* LinearService.LinearService;
        const store = yield* LinearLinkStore.LinearLinkStore;
        yield* linear.connect({ apiKey: KEY });
        const launched = yield* linear.recordLaunch(
          launchInput({
            target: { kind: "pipeline_run", targetId: "run-1", threadId, title: "x" },
            writeBack: { comment: false },
          }),
        );
        assert.isNull(launched.link.commentId);
        // A link created without a comment is never commented on by the reactor.
        assert.strictEqual(count(harness, "CreateComment"), 0);
        const stored = (yield* store.get(launched.link.linkId))!;
        assert.strictEqual(stored.link.commentMode, "none");
      }).pipe(Effect.provide(makeLayer(harness)));
    });

    it.effect(
      "posts a pipeline comment once Linear is readable again, once under racing syncs",
      () => {
        const harness = makeHarness();
        return Effect.gen(function* () {
          const linear = yield* LinearService.LinearService;
          const store = yield* LinearLinkStore.LinearLinkStore;
          yield* linear.connect({ apiKey: KEY });
          harness.handler = () => "network";
          const launched = yield* linear.recordLaunch(
            launchInput({
              issueId: "issue-2",
              issue: { identifier: "ATT-613", teamId: "team-1" },
              target: { kind: "pipeline_run", targetId: "run-1", threadId, title: "x" },
              writeBack: { comment: true },
            }),
          );
          assert.strictEqual(launched.link.commentMode, "pipeline");
          assert.isNull(launched.link.commentId);
          assert.deepStrictEqual(launched.warnings, []);

          harness.handler = okHandler();
          yield* TestClock.adjust("1 minute");
          const stored = (yield* store.get(launched.link.linkId))!;
          yield* Effect.all(
            [linear.syncPipelineComment(stored), linear.syncPipelineComment(stored)],
            {
              concurrency: "unbounded",
              discard: true,
            },
          );
          assert.strictEqual(count(harness, "CreateComment"), 1);
          assert.strictEqual((yield* store.get(launched.link.linkId))?.link.commentId, "comment-1");
        }).pipe(Effect.provide(makeLayer(harness)));
      },
    );
  });
});

describe("pipeline runs on another machine", () => {
  const remoteLaunch = launchInput({
    target: { kind: "pipeline_run", targetId: "run-9", threadId, title: "Feature delivery" },
    writeBack: { moveToStateId: "state-progress", comment: true },
    remote: {
      environmentId: EnvironmentId.make("env-b"),
      machineName: "Studio Mac",
      pipelineName: "Feature delivery",
    },
  });

  it.effect("stores the machine, moves the issue and posts one static comment", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const linear = yield* LinearService.LinearService;
      const store = yield* LinearLinkStore.LinearLinkStore;
      yield* linear.connect({ apiKey: KEY });
      const bodies: string[] = [];
      const base = okHandler();
      harness.handler = (operation, variables) => {
        if (operation === "CreateComment") bodies.push(String(variables.body));
        return base(operation, variables);
      };

      const launched = yield* linear.recordLaunch(remoteLaunch);
      assert.strictEqual(launched.link.environmentId, "env-b");
      assert.strictEqual(launched.link.commentMode, "thread");
      assert.strictEqual(launched.link.stateMovedTo, "state-progress");
      assert.strictEqual(count(harness, "MoveIssue"), 1);
      assert.strictEqual(count(harness, "CreateComment"), 1);
      assert.include(bodies[0], "Feature delivery");
      assert.include(bodies[0], "Studio Mac");
      assert.include(bodies[0], "https://t3.example/env/thread-1");

      // The reactor never reads this link, and a repeated record adds nothing.
      assert.deepStrictEqual(
        yield* store.listByCommentMode("pipeline", "1970-01-01T00:00:00.000Z"),
        [],
      );
      yield* linear.recordLaunch(remoteLaunch);
      assert.strictEqual(count(harness, "CreateComment"), 1);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("keeps the link in activity without reading the run", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const linear = yield* LinearService.LinearService;
      const store = yield* LinearLinkStore.LinearLinkStore;
      yield* linear.connect({ apiKey: KEY });
      yield* linear.recordLaunch(remoteLaunch);
      // Reading the run would fail: it only exists on the other machine.
      const pipelines = {
        getRun: () => Effect.die("run is on another machine"),
      } as unknown as PipelineService.PipelineService["Service"];
      const projection = {} as ProjectionStore.ProjectionStoreV2["Service"];

      const { issues } = yield* computeLinearActivity(store, pipelines, projection);
      const item = issues[0]?.items[0];
      assert.strictEqual(issues.length, 1);
      assert.strictEqual(item?.link.environmentId, "env-b");
      assert.strictEqual(item?.link.threadId, threadId);
      assert.strictEqual(item?.pipeline, null);
    }).pipe(Effect.provide(makeLayer(harness)));
  });
});

describe("linear_issue_links schema", () => {
  it.effect("adds the machine column to tables created without it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* LinearLinkStore.LinearLinkStore;
      const { ensureLinearSchema } = yield* Effect.promise(
        () => import("../persistence/LinearSchema.ts"),
      );
      yield* sql`DROP TABLE IF EXISTS linear_issue_links`;
      yield* sql`
        CREATE TABLE linear_issue_links (
          link_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, issue_identifier TEXT NOT NULL,
          team_id TEXT NOT NULL, project_id TEXT, target_kind TEXT NOT NULL,
          target_id TEXT NOT NULL, thread_id TEXT NOT NULL, created_at TEXT NOT NULL,
          comment_id TEXT, comment_mode TEXT NOT NULL, state_moved_to TEXT,
          thread_url TEXT NOT NULL DEFAULT '', comment_body_hash TEXT,
          UNIQUE (issue_id, target_kind, target_id)
        )
      `;
      yield* sql`
        INSERT INTO linear_issue_links (link_id, issue_id, issue_identifier, team_id, target_kind,
          target_id, thread_id, created_at, comment_mode)
        VALUES ('old', 'issue-1', 'ATT-1', 'team-1', 'pipeline_run', 'run-1', 'thread-1',
          '2026-10-30T10:00:00.000Z', 'pipeline')
      `;
      yield* ensureLinearSchema;
      const old = yield* store.get("old");
      assert.strictEqual(old?.link.environmentId, null);
      assert.strictEqual(old?.link.commentMode, "pipeline");
    }).pipe(
      Effect.provide(
        LinearLinkStore.layer.pipe(Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory))),
      ),
    ),
  );

  it.effect("is idempotent and keeps one link per issue and target", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* LinearLinkStore.LinearLinkStore;
      const { ensureLinearSchema } = yield* Effect.promise(
        () => import("../persistence/LinearSchema.ts"),
      );
      yield* ensureLinearSchema;
      yield* ensureLinearSchema;

      const link = {
        issueId: "issue-1",
        issueIdentifier: "ATT-1",
        teamId: "team-1",
        projectId: null,
        targetKind: "thread" as const,
        targetId: "thread-1",
        threadId: "thread-1",
        createdAt: "2026-10-30T10:00:00.000Z",
        commentMode: "none" as const,
        threadUrl: "https://t3.example/e/thread-1",
      };
      const first = yield* store.upsert({ ...link, linkId: "link-a" });
      const second = yield* store.upsert({ ...link, linkId: "link-b", commentMode: "thread" });
      assert.strictEqual(second.link.linkId, "link-a");
      assert.strictEqual(second.link.commentMode, first.link.commentMode);
      yield* store.upsert({ ...link, linkId: "link-c", targetKind: "pipeline_run" });
      yield* store.upsert({ ...link, linkId: "link-d", issueId: "issue-2" });
      assert.strictEqual((yield* sql`SELECT * FROM linear_issue_links`).length, 3);

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'linear_issue_links'
      `;
      assert.isTrue(indexes.some((index) => index.name === "idx_linear_issue_links_issue"));
      assert.isTrue(indexes.some((index) => index.name === "idx_linear_issue_links_thread"));
    }).pipe(
      Effect.provide(
        LinearLinkStore.layer.pipe(Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory))),
      ),
    ),
  );
});
