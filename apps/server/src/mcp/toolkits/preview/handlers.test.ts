import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
} from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import {
  claimPreviewRecording,
  normalizePreviewOpenInput,
  PreviewStandardToolkitHandlersLive,
} from "./handlers.ts";
import { PreviewStandardToolkit } from "./tools.ts";

describe("normalizePreviewOpenInput", () => {
  it("leaves an unstated visibility for the client preference to decide", () => {
    // Filling `open` in here would outrank `browserAutoShowFloatingPreview`,
    // which is desktop-local and cannot be read from the server.
    expect(normalizePreviewOpenInput({})).toEqual({ reuseExistingTab: true });
  });

  it("preserves an explicit background-only opt-out", () => {
    expect(normalizePreviewOpenInput({ open: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
  });

  it("supports show as a legacy alias while preferring open", () => {
    expect(normalizePreviewOpenInput({ show: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
    expect(normalizePreviewOpenInput({ open: true, show: false })).toEqual({
      open: true,
      reuseExistingTab: true,
      show: true,
    });
  });
});

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
          Layer.provideMerge(NodeServices.layer),
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
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("reports an older desktop without returning its inaccessible path", () =>
    Effect.gen(function* () {
      const result = yield* claimPreviewRecording(ThreadId.make("thread-1"), {
        id: "desktop-recording",
        tabId: "tab-1",
        path: "/desktop/recording.webm",
        mimeType: "video/webm",
        sizeBytes: 6,
        createdAt: "2026-09-07T00:00:00.000Z",
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      expect(result.failure._tag).toBe("PreviewAutomationRecordingDesktopUpdateRequiredError");
      expect(result.failure.message).toContain("Update the desktop app");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});

const scope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const tabId = PreviewTabId.make("tab-1");
type RequestEvent = Extract<PreviewAutomationStreamEvent, { type: "request" }>;

const makeHarness = Effect.fn("makePreviewToolkitHarness")(function* (settleMs = 0) {
  const broker = yield* PreviewAutomationBroker.make.pipe(Effect.provide(NodeServices.layer));
  const invocations: Array<PreviewAutomationBroker.PreviewAutomationInvokeInput> = [];
  const toolkitBroker = PreviewAutomationBroker.PreviewAutomationBroker.of({
    ...broker,
    invoke: <A>(input: PreviewAutomationBroker.PreviewAutomationInvokeInput) => {
      invocations.push(input);
      return broker.invoke<A>(input).pipe(Effect.tap(() => TestClock.adjust(settleMs)));
    },
  });
  const requests = yield* Queue.unbounded<RequestEvent>();
  const events = yield* broker.connect({
    clientId: "client-1",
    environmentId: scope.environmentId,
  });
  yield* Stream.runForEach(events, (event) =>
    event.type === "request" ? Queue.offer(requests, event) : Effect.void,
  ).pipe(Effect.forkScoped);
  const toolkit = yield* PreviewStandardToolkit.pipe(
    Effect.provide(PreviewStandardToolkitHandlersLive),
  );
  const evaluate = (timeoutMs?: number) =>
    toolkit.handle("preview_evaluate", { expression: "6 * 7", tabId, timeoutMs }).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((results) => results.at(-1)!.result),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, toolkitBroker),
    );
  const respond = (event: RequestEvent, result: unknown) =>
    broker.respond({
      clientId: "client-1",
      connectionId: event.connectionId,
      requestId: event.request.requestId,
      ok: true,
      result,
    });
  return { evaluate, respond, nextRequest: Queue.take(requests), invocations };
});

it.effect.each([100, 200])(
  "skips favicon lookup after the deadline with %i ms settlement",
  (settleMs) =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness(settleMs);
        const call = yield* harness.evaluate(1_000).pipe(Effect.forkScoped);
        const operation = yield* harness.nextRequest;
        yield* TestClock.adjust(900);
        yield* harness.respond(operation, 42);
        expect(yield* Fiber.join(call)).toEqual({ value: 42 });
        expect(harness.invocations.map((input) => input.operation)).toEqual(["evaluate"]);
      }),
    ),
);

it.effect.each([
  { timeoutMs: 1_000, operationMs: 900, metadataMs: 100 },
  { timeoutMs: undefined, operationMs: 14_900, metadataMs: 100 },
  { timeoutMs: 2_000, operationMs: 500, metadataMs: 500 },
])("returns the operation result when favicon lookup exhausts its budget: %j", (testCase) =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const call = yield* harness.evaluate(testCase.timeoutMs).pipe(Effect.forkScoped);
      const operation = yield* harness.nextRequest;
      yield* TestClock.adjust(testCase.operationMs);
      yield* harness.respond(operation, 42);
      const metadata = yield* harness.nextRequest;
      expect(metadata.request).toMatchObject({
        operation: "status",
        tabId,
        timeoutMs: testCase.metadataMs,
      });
      yield* TestClock.adjust(testCase.metadataMs);
      expect(yield* Fiber.join(call)).toEqual({ value: 42 });
    }),
  ),
);

it.effect("retains favicon metadata when the targeted lookup finishes within the deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const call = yield* harness.evaluate(1_000).pipe(Effect.forkScoped);
      const operation = yield* harness.nextRequest;
      yield* TestClock.adjust(900);
      yield* harness.respond(operation, 42);
      const metadata = yield* harness.nextRequest;
      yield* TestClock.adjust(50);
      yield* harness.respond(metadata, { url: "https://example.com/page" });
      expect(yield* Fiber.join(call)).toEqual({
        value: 42,
        toolIcon: { _tag: "website", pageUrl: "https://example.com/page" },
      });
    }),
  ),
);
