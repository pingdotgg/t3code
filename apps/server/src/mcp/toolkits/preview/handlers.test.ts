import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  PREVIEW_AUTOMATION_SERVER_OPERATIONS,
  ThreadId,
  type PreviewAutomationRequest,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import {
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
} from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { claimPreviewRecording, layerFill, layerStandard } from "./handlers.ts";
import { PreviewFillToolkit, PreviewStandardToolkit } from "./tools.ts";

it.effect("preview_open navigates the opened tab to a dev server in one tool call", () =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const connected = yield* Deferred.make<void>();
    const tabId = PreviewTabId.make("opened-tab");
    const target = {
      kind: "environment-port" as const,
      port: 3000,
      path: "/settings?tab=account",
    };
    const requests: PreviewAutomationRequest[] = [];
    const status = {
      available: true,
      visible: false,
      tabId,
      url: "http://localhost:3000/settings?tab=account",
      title: "Settings",
      loading: false,
    };
    const events = yield* broker.connect({
      clientId: "client-1",
      environmentId: scope.environmentId,
    });
    yield* Stream.runForEach(events, (event) => {
      if (event.type === "connected") return Deferred.succeed(connected, undefined);
      requests.push(event.request);
      return broker.respond({
        clientId: "client-1",
        connectionId: event.connectionId,
        requestId: event.request.requestId,
        ok: true,
        result: event.request.operation === "open" ? { ...status, url: "about:blank" } : status,
      });
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(connected);
    const toolkit = yield* PreviewStandardToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(layerStandard)),
    );
    const results = yield* toolkit
      .handle("preview_open", {
        url: "http://localhost:3000",
        target,
        open: false,
        reuseExistingTab: false,
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(results.at(-1)?.result).toEqual(status);
    expect(requests.map(({ operation, input }) => ({ operation, input }))).toEqual([
      { operation: "open", input: { open: false, show: false, reuseExistingTab: false } },
      { operation: "navigate", input: { target } },
    ]);
    expect(requests[1]?.tabId).toBe(tabId);
    expect(requests[1]?.tabIdExplicit).toBe(true);
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment-1"),
      requestNamespace: "provider-session-1",
      thread: {
        threadId: ThreadId.make("thread-1"),
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["preview"] as const),
      issuedAt: 1,
    }),
    Effect.provide(
      Layer.mergeAll(PreviewAutomationBroker.layer, liveThreadsLayer).pipe(
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

describe("claimPreviewRecording", () => {
  it.effect("overlapping and repeated claims return the same retained recording", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const uploadedAttachmentId = createPendingAttachmentId(".webm");
      const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(pendingPath, "video!");
      const response = {
        id: "desktop-recording",
        tabId: "tab-1",
        path: "/desktop/recording.webm",
        mimeType: "video/webm",
        sizeBytes: 6,
        createdAt: "2026-09-07T00:00:00.000Z",
        uploadedAttachmentId,
      };
      const claim = claimPreviewRecording(ThreadId.make("thread-1"), response);
      const [first, second] = yield* Effect.all([claim, claim], { concurrency: "unbounded" });
      expect(first).toEqual(second);
      expect(yield* claim).toEqual(first);
      expect(yield* fileSystem.readFileString(first.path)).toBe("video!");
      expect(yield* fileSystem.exists(pendingPath)).toBe(false);
      const wrongThread = yield* claimPreviewRecording(ThreadId.make("thread-2"), response).pipe(
        Effect.result,
      );
      expect(wrongThread._tag).toBe("Failure");
      const wrongPath = yield* claimPreviewRecording(ThreadId.make("thread-1"), {
        ...response,
        uploadedAttachmentId: `../${uploadedAttachmentId}`,
      }).pipe(Effect.result);
      expect(wrongPath._tag).toBe("Failure");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );

  it.effect.each([6, 5])(
    "claims only a complete uploaded recording (reported bytes: %s)",
    (sizeBytes) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const uploadedAttachmentId = createPendingAttachmentId(".webm");
        const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
        yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(pendingPath, "video!");
        const response = {
          id: "desktop-recording",
          tabId: "tab-1",
          path: "/desktop/recording.webm",
          mimeType: "video/webm",
          sizeBytes,
          createdAt: "2026-09-07T00:00:00.000Z",
          uploadedAttachmentId,
        };
        const result = yield* claimPreviewRecording(ThreadId.make("thread-1"), response).pipe(
          Effect.result,
        );
        if (sizeBytes === 6) {
          expect(result._tag).toBe("Success");
          if (result._tag !== "Success") return;
          expect(result.success.path).not.toBe(response.path);
          expect(parseThreadSegmentFromAttachmentId(result.success.id)).toBe("thread-1");
          expect(yield* fileSystem.readFileString(result.success.path)).toBe("video!");
          expect(yield* fileSystem.exists(pendingPath)).toBe(false);
        } else {
          expect(result._tag).toBe("Failure");
          if (result._tag !== "Failure") return;
          expect(result.failure._tag).toBe("PreviewAutomationRecordingTransferError");
          expect(yield* fileSystem.exists(pendingPath)).toBe(true);
        }
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
  );
});

describe("preview_request_fill", () => {
  const LOGIN = "https://login.example.test";
  const tabId = PreviewTabId.make("login-tab");
  const scopeLayer = Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId: EnvironmentId.make("environment-1"),
    requestNamespace: "provider-session-1",
    thread: {
      threadId: ThreadId.make("thread-1"),
      providerSessionId: "provider-session-1",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["preview"] as const),
    issuedAt: 1,
  });

  /** Runs the tool against a fake browser host and a card the user answers with `answer`. */
  const runFill = (
    answer:
      | { readonly status: "saved"; readonly value: Redacted.Redacted<string> }
      | { readonly status: "declined"; readonly note: string },
    options: { readonly fillFails?: boolean } = {},
  ) => {
    const asked: unknown[] = [];
    return Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      const requests: PreviewAutomationRequest[] = [];
      const events = yield* broker.connect({
        clientId: "client-1",
        environmentId: scope.environmentId,
        supportedOperations: PREVIEW_AUTOMATION_SERVER_OPERATIONS,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        requests.push(event.request);
        const input = event.request.input as { readonly value?: string };
        const failing = options.fillFails === true && input.value !== undefined;
        return broker.respond({
          clientId: "client-1",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ...(failing
            ? {
                ok: false,
                error: {
                  _tag: "PreviewAutomationTargetNotEditableError",
                  message: "The field is now on a different site than the one the user was shown.",
                },
              }
            : {
                ok: true,
                result:
                  event.request.operation === "fill"
                    ? { tabId, origin: LOGIN }
                    : { available: true, visible: true, tabId, url: `${LOGIN}/signin` },
              }),
        });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);
      const toolkit = yield* PreviewFillToolkit.pipe(
        Effect.provide(McpToolAccess.HandlersLayer.layer(layerFill)),
      );
      const results = yield* toolkit
        .handle("preview_request_fill", {
          locator: "aria-ref=t3-1-e5",
          label: "Example password",
          reason: "Sign in to check the order history.",
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      return { result: results.at(-1)?.result, requests, asked };
    }).pipe(
      Effect.provideService(
        OrchestratorMcpService.OrchestratorMcpService,
        OrchestratorMcpService.OrchestratorMcpService.of({
          requestBrowserValue: (_scope: unknown, input: unknown) =>
            Effect.sync(() => {
              asked.push(input);
              return answer;
            }),
        } as unknown as OrchestratorMcpService.OrchestratorMcpService["Service"]),
      ),
      Effect.provide(
        Layer.mergeAll(PreviewAutomationBroker.layer, liveThreadsLayer, scopeLayer).pipe(
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    );
  };

  const fills = (requests: ReadonlyArray<PreviewAutomationRequest>) =>
    requests.filter((request) => request.operation === "fill");

  it.effect("checks the field, asks with the page's site, then fills only the page", () =>
    Effect.gen(function* () {
      const { result, requests, asked } = yield* runFill({
        status: "saved",
        value: Redacted.make("correct horse"),
      });
      expect(result).toMatchObject({ status: "filled" });
      expect(JSON.stringify(result)).not.toContain("correct horse");
      expect(asked).toEqual([
        {
          label: "Example password",
          reason: "Sign in to check the order history.",
          url: LOGIN,
          timeoutMs: undefined,
          clientRequestId: undefined,
        },
      ]);
      expect(fills(requests).map(({ input, tabId: target }) => ({ input, target }))).toEqual([
        { input: { locator: "aria-ref=t3-1-e5", kind: "password" }, target: undefined },
        {
          input: {
            locator: "aria-ref=t3-1-e5",
            kind: "password",
            value: "correct horse",
            expectedOrigin: LOGIN,
          },
          target: tabId,
        },
      ]);
    }),
  );

  it.effect("drops the value and says the page changed when the fill is refused", () =>
    Effect.gen(function* () {
      const { result } = yield* runFill(
        { status: "saved", value: Redacted.make("correct horse") },
        { fillFails: true },
      );
      expect(result).toMatchObject({ status: "field_changed" });
      expect(JSON.stringify(result)).not.toContain("correct horse");
    }),
  );

  it.effect("a declined card fills nothing", () =>
    Effect.gen(function* () {
      const { result, requests } = yield* runFill({
        status: "declined",
        note: "The user declined.",
      });
      expect(result).toMatchObject({ status: "declined", note: "The user declined." });
      expect(fills(requests)).toHaveLength(1);
    }),
  );
});
