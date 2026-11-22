import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadViewers from "../orchestration-v2/ThreadViewers.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WebhookNotificationService from "./WebhookNotificationService.ts";

const ENV_ID = EnvironmentId.make("env-1");
const PROJECT_ID = ProjectId.make("proj-1");
const THREAD_ID = ThreadId.make("thread-42");
const CREATED_AT_ISO = "2026-11-22T12:00:00.000Z";
const CREATED_AT = DateTime.makeUnsafe(CREATED_AT_ISO);

const PROJECT: Project = {
  id: PROJECT_ID,
  title: "KBCode",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: CREATED_AT_ISO,
  updatedAt: CREATED_AT_ISO,
  deletedAt: null,
};

function makeThreadShell(
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Refactor auth",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "running",
    activityRunStatus: "running",
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: RunId.make("run-1"),
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

function decodeBody(request: HttpClientRequest.HttpClientRequest): string {
  const body = request.body;
  if (body._tag === "Uint8Array") {
    return new TextDecoder().decode(body.body);
  }
  return "";
}

function makeHarness(input: {
  readonly env: Readonly<Record<string, string>>;
  readonly getThread: () => OrchestrationV2ThreadShell | null;
}) {
  const recorded: Array<RecordedRequest> = [];
  const httpClientLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        recorded.push({
          url: request.url,
          method: request.method,
          headers: request.headers,
          body: decodeBody(request),
        });
        return HttpClientResponse.fromWeb(request, new Response("ok", { status: 200 }));
      }),
    ),
  );

  const threadsLayer = Layer.mock(ThreadManagement.ThreadManagementService)({
    getAgentAwarenessSnapshot: () =>
      Effect.sync(() => {
        const current = input.getThread();
        return {
          snapshotSequence: 1,
          threads: current ? [current] : [],
        };
      }),
    streamDomainEvents: Stream.empty,
  });

  const projectsLayer = Layer.mock(ProjectService.ProjectService)({
    getById: (id) => Effect.succeed(id === PROJECT_ID ? Option.some(PROJECT) : Option.none()),
  });

  const envLayer = Layer.mock(ServerEnvironment.ServerEnvironment)({
    getEnvironmentId: Effect.succeed(ENV_ID),
  });

  const baseLayer = Layer.mergeAll(
    threadsLayer,
    projectsLayer,
    envLayer,
    ThreadViewers.layer,
    httpClientLayer,
  );

  const serviceLayer = WebhookNotificationService.layer.pipe(
    Layer.provideMerge(baseLayer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env }))),
  );

  return { recorded, serviceLayer };
}

describe("WebhookNotificationService", () => {
  it.effect("is a no-op when neither ntfy nor Telegram env vars are configured", () =>
    Effect.gen(function* () {
      const current = makeThreadShell({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("req-1"),
          kind: "command",
          createdAt: CREATED_AT,
        },
      });
      const { recorded, serviceLayer } = makeHarness({
        env: {},
        getThread: () => current,
      });

      yield* Effect.gen(function* () {
        const service = yield* WebhookNotificationService.WebhookNotificationService;
        yield* service.evaluateThread(THREAD_ID);
        yield* service.notifyCustom({
          event: "sandbox_auto_stopped",
          title: "Sandbox stopped",
          body: "Idle timeout reached",
        });
      }).pipe(Effect.provide(serviceLayer));

      assert.strictEqual(recorded.length, 0);
    }),
  );

  it.effect(
    "dispatches ntfy and Telegram alerts with kbcode://thread/<id> deep links and deduplicates repeats",
    () =>
      Effect.gen(function* () {
        let current = makeThreadShell({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("req-approval-1"),
            kind: "command",
            createdAt: CREATED_AT,
          },
        });
        const { recorded, serviceLayer } = makeHarness({
          env: {
            NTFY_TOPIC_URL: "https://ntfy.sh/kbcode-test-topic",
            NTFY_AUTH_TOKEN: "tk_secret_123",
            TELEGRAM_BOT_TOKEN: "12345:bot-token",
            TELEGRAM_CHAT_ID: "998877",
          },
          getThread: () => current,
        });

        yield* Effect.gen(function* () {
          const service = yield* WebhookNotificationService.WebhookNotificationService;
          yield* service.evaluateThread(THREAD_ID);
          // Second evaluation for the same approval request is deduplicated.
          yield* service.evaluateThread(THREAD_ID);

          // Transition to completed dispatches a fresh completion alert.
          current = makeThreadShell({
            status: "completed",
            activityRunStatus: null,
            pendingRuntimeRequest: null,
            latestRunId: RunId.make("run-2"),
            latestRunCompletedAt: DateTime.makeUnsafe("2026-11-22T12:05:00.000Z"),
          });
          yield* service.evaluateThread(THREAD_ID);
        }).pipe(Effect.provide(serviceLayer));

        assert.strictEqual(recorded.length, 4);

        const ntfyApproval = recorded.find(
          (req) =>
            req.url === "https://ntfy.sh/kbcode-test-topic" && req.headers.priority === "high",
        );
        assert.isDefined(ntfyApproval);
        assert.strictEqual(ntfyApproval.headers.click, "kbcode://thread/thread-42");
        assert.strictEqual(ntfyApproval.headers.authorization, "Bearer tk_secret_123");
        assert.include(ntfyApproval.headers.title ?? "", "KBCode");
        assert.include(ntfyApproval.body, "kbcode://thread/thread-42");

        const telegramApproval = recorded.find((req) =>
          req.url.startsWith("https://api.telegram.org/bot"),
        );
        assert.isDefined(telegramApproval);
        const telegramPayload = JSON.parse(telegramApproval.body) as {
          chat_id: string;
          text: string;
        };
        assert.strictEqual(telegramPayload.chat_id, "998877");
        assert.include(telegramPayload.text, "kbcode://thread/thread-42");
      }),
  );

  it.effect("suppresses dispatch while an active client socket is viewing the thread", () =>
    Effect.gen(function* () {
      const current = makeThreadShell({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("req-approval-2"),
          kind: "command",
          createdAt: CREATED_AT,
        },
      });
      const { recorded, serviceLayer } = makeHarness({
        env: {
          NTFY_TOPIC_URL: "https://ntfy.sh/kbcode-viewed-test",
        },
        getThread: () => current,
      });

      yield* Effect.gen(function* () {
        const viewers = yield* ThreadViewers.ThreadViewers;
        const service = yield* WebhookNotificationService.WebhookNotificationService;
        const viewerScope = yield* Scope.make();
        yield* viewers.view(THREAD_ID).pipe(Scope.provide(viewerScope));
        yield* service.evaluateThread(THREAD_ID);
        yield* Scope.close(viewerScope, Exit.void);
      }).pipe(Effect.provide(serviceLayer));

      assert.strictEqual(recorded.length, 0);
    }),
  );

  it.effect("delivers custom sandbox alerts via notifyCustom", () =>
    Effect.gen(function* () {
      const { recorded, serviceLayer } = makeHarness({
        env: {
          NTFY_TOPIC_URL: "https://ntfy.sh/kbcode-sandbox-test",
        },
        getThread: () => null,
      });

      yield* Effect.gen(function* () {
        const service = yield* WebhookNotificationService.WebhookNotificationService;
        yield* service.notifyCustom({
          event: "sandbox_warning",
          title: "KBCode: Vercel sandbox nearing 45m limit",
          body: "Auto-snapshotting in 3 minutes.",
          deepLink: "kbcode://thread/thread-42",
        });
      }).pipe(Effect.provide(serviceLayer));

      assert.strictEqual(recorded.length, 1);
      assert.strictEqual(recorded[0]?.headers.priority, "high");
      assert.strictEqual(recorded[0]?.headers.click, "kbcode://thread/thread-42");
      assert.include(recorded[0]?.body ?? "", "Auto-snapshotting in 3 minutes.");
    }),
  );
});
