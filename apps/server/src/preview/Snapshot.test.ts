import * as NodeVM from "node:vm";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationNoAvailableHostError,
  PreviewAutomationRequestQueueClosedError,
  PreviewAutomationTimeoutError,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import {
  PreviewAutomationBroker,
  type PreviewAutomationInvokeInput,
} from "../mcp/PreviewAutomationBroker.ts";
import * as Snapshot from "./Snapshot.ts";

const tabId = PreviewTabId.make("text-tab");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const scope = {
  environmentId: EnvironmentId.make("text-environment"),
  requestNamespace: "text-request-namespace",
  thread: {
    threadId: ThreadId.make("text-thread"),
    providerSessionId: "text-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const TestLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-text-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const makePage = (initialText: string) => {
  let text = initialText;
  let reads = 0;
  const timers = new Map<() => void, number>();
  const listeners = new Set<() => void>();
  const requests: PreviewAutomationInvokeInput[] = [];
  const context = NodeVM.createContext({
    TextEncoder,
    document: {
      body: {
        get innerText() {
          reads++;
          return text;
        },
      },
    },
    location: { href: "https://example.test/page" },
    setTimeout: (callback: () => void, delay: number) => {
      timers.set(callback, delay);
      return callback;
    },
    clearTimeout: (callback: () => void) => timers.delete(callback),
    addEventListener: (event: string, callback: () => void) => {
      expect(event).toBe("pagehide");
      listeners.add(callback);
    },
    removeEventListener: (event: string, callback: () => void) => {
      expect(event).toBe("pagehide");
      listeners.delete(callback);
    },
  });
  const page = {
    context,
    timers,
    listeners,
    requests,
    reads: () => reads,
    available: true,
    setText: (value: string) => {
      text = value;
    },
    beforeSnapshot: undefined as (() => void) | undefined,
    snapshotGate: undefined as Effect.Effect<void> | undefined,
    captureGate: undefined as Effect.Effect<void> | undefined,
    chunkGate: undefined as Effect.Effect<void> | undefined,
    broker: undefined as PreviewAutomationBroker["Service"] | undefined,
  };
  const invoke = <A>(request: PreviewAutomationInvokeInput) =>
    Effect.gen(function* () {
      requests.push(request);
      if (request.operation === "status") {
        return {
          available: page.available,
          visible: true,
          tabId,
          url: "https://example.test/page",
          title: "Page",
          loading: false,
        } as A;
      }
      if (request.tabId !== undefined && request.tabId !== tabId) {
        return yield* new PreviewAutomationNoAvailableHostError({
          environmentId: scope.environmentId,
          ...scope.thread,
          operation: request.operation,
        });
      }
      if (request.operation === "snapshot") {
        page.beforeSnapshot?.();
        if (page.snapshotGate) yield* page.snapshotGate;
        return {
          url: NodeVM.runInContext("location.href", context),
          title: "Page",
          loading: false,
          visibleText: "Page",
          interactiveElements: [],
          accessibilityTree: {},
          consoleEntries: [],
          networkEntries: [],
          actionTimeline: [],
          screenshot: {
            mimeType: "image/png",
            data: Buffer.from("png").toString("base64"),
            width: 10,
            height: 5,
          },
        } as A;
      }
      expect(request.operation).toBe("evaluate");
      expect(request.tabId).toBe(tabId);
      expect(request.timeoutMs).toBeUndefined();
      expect(request.updateCurrentTab).toBe(false);
      const expression = (request.input as { expression: string }).expression;
      if (expression.includes("let end") && page.chunkGate) yield* page.chunkGate;
      const value = yield* Effect.try({
        try: () => {
          const value = NodeVM.runInContext(expression, context) as A;
          expect(Buffer.byteLength(encodeJson(value), "utf8")).toBeLessThan(16_512);
          return value;
        },
        catch: () =>
          new PreviewAutomationNoAvailableHostError({
            environmentId: scope.environmentId,
            ...scope.thread,
            operation: "evaluate",
          }),
      });
      if (expression.includes("Object.defineProperty") && page.captureGate) yield* page.captureGate;
      return value;
    });
  page.broker = PreviewAutomationBroker.of({
    invoke,
    connect: () => Effect.die("unused"),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
  });
  return page;
};

const captureText = Effect.fnUntraced(function* (requestedTabId?: PreviewTabId) {
  const snapshot = yield* Snapshot.PreviewSnapshot;
  return yield* snapshot.withSnapshot(
    {
      scope,
      captureText: true,
      ...(requestedTabId === undefined ? {} : { tabId: requestedTabId }),
    },
    ({ textCapture }) => Effect.succeed(textCapture!),
  );
});
const readText = Effect.fnUntraced(function* (
  captureId: string,
  offset = 0,
  release = false,
  requestScope = scope,
  requestedTabId = tabId,
) {
  const snapshot = yield* Snapshot.PreviewSnapshot;
  return yield* snapshot.readText({
    scope: requestScope,
    tabId: requestedTabId,
    captureId,
    offset,
    release,
  });
});
const providePage = (page: ReturnType<typeof makePage>) =>
  Effect.provide(
    Snapshot.layer.pipe(Layer.provide(Layer.succeed(PreviewAutomationBroker, page.broker!))),
  );
const assertClean = (page: ReturnType<typeof makePage>) => {
  expect(page.timers.size).toBe(0);
  expect(page.listeners.size).toBe(0);
  expect(
    Object.getOwnPropertyNames(page.context).filter((name) =>
      name.startsWith("__t3_text_capture_"),
    ),
  ).toEqual([]);
};

it.effect("leaves default snapshots unchanged and does not create browser or disk text", () => {
  const page = makePage("loaded text");
  return Effect.gen(function* () {
    const snapshots = yield* Snapshot.PreviewSnapshot;
    const result = yield* snapshots.withSnapshot({ scope }, Effect.succeed);
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    expect(result.textCapture).toBeUndefined();
    expect(result.snapshot.visibleText).toBe("Page");
    expect(Buffer.from(result.png).toString()).toBe("png");
    expect(page.reads()).toBe(0);
    expect(page.requests.map((request) => request.operation)).toEqual(["snapshot"]);
    expect(yield* fs.exists(config.browserArtifactsDir)).toBe(false);
    assertClean(page);
  }).pipe(providePage(page), Effect.provide(TestLayer));
});

it.effect(
  "reads all loaded text in bounded parts without disk writes or repeated DOM reads",
  () => {
    const text = "\u0001".repeat(70_000) + "loaded end";
    const page = makePage(text);
    return Effect.gen(function* () {
      const captured = yield* captureText();
      expect(captured).toMatchObject({
        totalChars: text.length,
        tabId,
        url: "https://example.test/page",
      });
      expect(page.requests[0]?.operation).toBe("status");
      expect(page.requests.filter((request) => request.operation === "evaluate")).toHaveLength(2);
      let offset = 0;
      let collected = "";
      while (offset < captured.totalChars) {
        const part = yield* readText(captured.captureId, offset);
        expect(part.text.length).toBeLessThanOrEqual(4096);
        expect(part.nextOffset).toBe(offset + part.text.length);
        expect(part.totalChars).toBe(text.length);
        expect(part.done).toBe(part.nextOffset === text.length);
        expect(part.released).toBe(false);
        collected += part.text;
        offset = part.nextOffset;
      }
      expect(collected).toBe(text);
      expect(page.reads()).toBe(1);
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      expect(yield* fs.exists(config.browserArtifactsDir)).toBe(false);
      yield* readText(captured.captureId, 0, true);
      assertClean(page);
    }).pipe(providePage(page), Effect.provide(TestLayer));
  },
);

it.effect("preserves Unicode pairs at read boundaries and rejects an offset inside a pair", () => {
  const text = "a".repeat(4095) + "😀中文" + "b".repeat(4093) + "🚀";
  const page = makePage(text);
  return Effect.gen(function* () {
    const captured = yield* captureText(tabId);
    const first = yield* readText(captured.captureId);
    expect(first.text).toBe("a".repeat(4095));
    const second = yield* readText(captured.captureId, first.nextOffset);
    expect(second.text.startsWith("😀中文")).toBe(true);
    const third = yield* readText(captured.captureId, second.nextOffset);
    expect(first.text + second.text + third.text).toBe(text);
    expect(yield* Effect.flip(readText(captured.captureId, 4096))).toBeInstanceOf(
      Snapshot.PreviewTextCaptureError,
    );
    expect(page.requests.some((request) => request.operation === "status")).toBe(false);
    yield* readText(captured.captureId, 0, true);
    assertClean(page);
  }).pipe(providePage(page), Effect.provide(TestLayer));
});

it.effect.each(["", "short text"])("retains completed reads for retries: %j", (text) => {
  const page = makePage(text);
  return Effect.gen(function* () {
    const captured = yield* captureText();
    const first = yield* readText(captured.captureId);
    expect(first).toEqual({
      text,
      nextOffset: text.length,
      totalChars: text.length,
      done: true,
      released: false,
    });
    expect(yield* readText(captured.captureId)).toEqual(first);
    expect(yield* readText(captured.captureId, text.length)).toEqual({
      text: "",
      nextOffset: text.length,
      totalChars: text.length,
      done: true,
      released: false,
    });
    const released = yield* readText(captured.captureId, 0, true);
    expect(released).toEqual({
      text: "",
      nextOffset: 0,
      totalChars: text.length,
      done: true,
      released: true,
    });
    expect(yield* Effect.flip(readText(captured.captureId))).toBeInstanceOf(
      Snapshot.PreviewTextCaptureError,
    );
    assertClean(page);
  }).pipe(providePage(page), Effect.provide(TestLayer));
});

it.effect("freezes loaded text while the same document changes", () => {
  const page = makePage("original ".repeat(9000));
  return Effect.gen(function* () {
    page.beforeSnapshot = () => page.setText("changed before snapshot");
    const captured = yield* captureText();
    const key = Object.getOwnPropertyNames(page.context).find((name) =>
      name.startsWith("__t3_text_capture_"),
    )!;
    expect(
      NodeVM.runInContext(`Object.isFrozen(globalThis[${encodeJson(key)}])`, page.context),
    ).toBe(true);
    page.setText("changed before read");
    expect((yield* readText(captured.captureId)).text).toBe(
      "original ".repeat(9000).slice(0, 4096),
    );
    expect(page.reads()).toBe(1);
    yield* readText(captured.captureId, 0, true);
    assertClean(page);
  }).pipe(providePage(page), Effect.provide(TestLayer));
});

it.effect.each(["navigation", "reload", "new document"] as const)(
  "rejects %s before snapshot delivery and removes its capture",
  (change) => {
    const page = makePage("original loaded text");
    return Effect.gen(function* () {
      page.beforeSnapshot = () => {
        if (change === "navigation")
          NodeVM.runInContext("location.href = 'https://other.test/'", page.context);
        else {
          if (change === "reload") [...page.listeners][0]!();
          NodeVM.runInContext(
            "document = { body: { innerText: 'different document' } }",
            page.context,
          );
        }
      };
      expect(yield* Effect.flip(captureText())).toBeInstanceOf(Snapshot.PreviewTextCaptureError);
      assertClean(page);
    }).pipe(providePage(page), Effect.provide(TestLayer));
  },
);

it.effect("validates a full page URL longer than the evaluate output limit", () => {
  const page = makePage("loaded text");
  return Effect.gen(function* () {
    const url = `https://example.test/page?q=${"x".repeat(70_000)}`;
    NodeVM.runInContext(`location.href = ${encodeJson(url)}`, page.context);
    const captured = yield* captureText();
    expect(captured.url).toBe(url.slice(0, 2048));
    expect((yield* readText(captured.captureId)).text).toBe("loaded text");
    expect(page.reads()).toBe(1);
    yield* readText(captured.captureId, 0, true);
    assertClean(page);
  }).pipe(providePage(page), Effect.provide(TestLayer));
});

it.effect.each(["navigation", "expiry", "pagehide", "new document"] as const)(
  "rejects further reads after %s",
  (failure) => {
    const page = makePage("text ".repeat(2000));
    return Effect.gen(function* () {
      const captured = yield* captureText();
      yield* readText(captured.captureId);
      if (failure === "navigation")
        NodeVM.runInContext("location.href = 'https://other.test/'", page.context);
      else if (failure === "expiry") {
        expect([...page.timers.values()]).toEqual([300_000]);
        [...page.timers.keys()][0]!();
      } else if (failure === "pagehide") [...page.listeners][0]!();
      else NodeVM.runInContext("document = { body: { innerText: 'different' } }", page.context);
      expect(yield* Effect.flip(readText(captured.captureId, 4096))).toBeInstanceOf(
        Snapshot.PreviewTextCaptureError,
      );
      if (page.timers.size > 0) [...page.timers.keys()][0]!();
      assertClean(page);
    }).pipe(providePage(page), Effect.provide(TestLayer));
  },
);

it.effect.each(["environmentId", "threadId", "providerSessionId", "providerInstanceId"] as const)(
  "does not disclose or release another %s's capture",
  (field) => {
    const page = makePage("private text");
    return Effect.gen(function* () {
      const captured = yield* captureText();
      const otherScope = {
        ...scope,
        environmentId:
          field === "environmentId" ? EnvironmentId.make("other-environment") : scope.environmentId,
        thread: {
          threadId: field === "threadId" ? ThreadId.make("other-thread") : scope.thread.threadId,
          providerSessionId:
            field === "providerSessionId" ? "other-session" : scope.thread.providerSessionId,
          providerInstanceId:
            field === "providerInstanceId"
              ? ProviderInstanceId.make("other-provider")
              : scope.thread.providerInstanceId,
        },
      };
      expect(yield* Effect.flip(readText(captured.captureId, 0, false, otherScope))).toBeInstanceOf(
        Snapshot.PreviewTextCaptureError,
      );
      expect(yield* Effect.flip(readText(captured.captureId, 0, true, otherScope))).toBeInstanceOf(
        Snapshot.PreviewTextCaptureError,
      );
      expect((yield* readText(captured.captureId)).text).toBe("private text");
      yield* readText(captured.captureId, 0, true);
      assertClean(page);
    }).pipe(providePage(page), Effect.provide(TestLayer));
  },
);

it.effect("rejects a different tab or capture version without releasing the valid capture", () => {
  const page = makePage("private text");
  return Effect.gen(function* () {
    const captured = yield* captureText();
    expect(
      yield* Effect.flip(
        readText(captured.captureId, 0, false, scope, PreviewTabId.make("other-tab")),
      ),
    ).toBeInstanceOf(PreviewAutomationNoAvailableHostError);
    expect(yield* Effect.flip(readText("wrong-capture"))).toBeInstanceOf(
      Snapshot.PreviewTextCaptureError,
    );
    expect(yield* Effect.flip(readText("wrong-capture", 0, true))).toBeInstanceOf(
      Snapshot.PreviewTextCaptureError,
    );
    expect((yield* readText(captured.captureId)).text).toBe("private text");
    yield* readText(captured.captureId, 0, true);
    assertClean(page);
  }).pipe(providePage(page), Effect.provide(TestLayer));
});

it.effect.each([-1, 0.5, 5, Number.NaN, Number.POSITIVE_INFINITY])(
  "rejects invalid offset %s without damaging the capture",
  (offset) => {
    const page = makePage("text");
    return Effect.gen(function* () {
      const captured = yield* captureText();
      expect(yield* Effect.flip(readText(captured.captureId, offset))).toBeInstanceOf(
        Snapshot.PreviewTextCaptureError,
      );
      expect((yield* readText(captured.captureId)).text).toBe("text");
      yield* readText(captured.captureId, 0, true);
      assertClean(page);
    }).pipe(providePage(page), Effect.provide(TestLayer));
  },
);

it.effect("replaces the prior capture and keeps one timer and page listener", () => {
  const page = makePage("first text");
  return Effect.gen(function* () {
    const first = yield* captureText();
    page.setText("second text");
    const second = yield* captureText();
    expect(second.captureId).not.toBe(first.captureId);
    expect(page.timers.size).toBe(1);
    expect(page.listeners.size).toBe(1);
    expect(yield* Effect.flip(readText(first.captureId))).toBeInstanceOf(
      Snapshot.PreviewTextCaptureError,
    );
    expect(yield* Effect.flip(readText(first.captureId, 0, true))).toBeInstanceOf(
      Snapshot.PreviewTextCaptureError,
    );
    expect((yield* readText(second.captureId)).text).toBe("second text");
    yield* readText(second.captureId, 0, true);
    assertClean(page);
  }).pipe(providePage(page), Effect.provide(TestLayer));
});

it.effect.each(["failure", "cancellation"] as const)(
  "removes an undelivered capture after result delivery %s",
  (outcome) => {
    const page = makePage("completed text");
    return Effect.gen(function* () {
      const enteredUse = yield* Deferred.make<void>();
      const snapshots = yield* Snapshot.PreviewSnapshot;
      const fiber = yield* Effect.forkChild(
        snapshots.withSnapshot({ scope, captureText: true }, ({ textCapture }) =>
          Effect.gen(function* () {
            expect(textCapture?.totalChars).toBe(14);
            yield* Deferred.succeed(enteredUse, undefined);
            return yield* outcome === "failure" ? Effect.fail("delivery failed") : Effect.never;
          }),
        ),
      );
      yield* Deferred.await(enteredUse);
      if (outcome === "cancellation") yield* Fiber.interrupt(fiber);
      expect((yield* Fiber.await(fiber))._tag).toBe("Failure");
      assertClean(page);
    }).pipe(providePage(page), Effect.provide(TestLayer));
  },
);

it.effect("does not let cancelled old delivery remove a newer capture", () => {
  const page = makePage("first text");
  return Effect.gen(function* () {
    const enteredUse = yield* Deferred.make<void>();
    const snapshots = yield* Snapshot.PreviewSnapshot;
    const fiber = yield* Effect.forkChild(
      snapshots.withSnapshot({ scope, captureText: true }, () =>
        Deferred.succeed(enteredUse, undefined).pipe(Effect.andThen(Effect.never)),
      ),
    );
    yield* Deferred.await(enteredUse);
    page.setText("new text");
    const captured = yield* captureText();
    yield* Fiber.interrupt(fiber);
    expect((yield* readText(captured.captureId)).text).toBe("new text");
    expect(page.timers.size).toBe(1);
    yield* readText(captured.captureId, 0, true);
    assertClean(page);
  }).pipe(providePage(page), Effect.provide(TestLayer));
});

it.effect("removes the capture when snapshot collection is interrupted", () => {
  const page = makePage("loaded text");
  return Effect.gen(function* () {
    const enteredSnapshot = yield* Deferred.make<void>();
    page.snapshotGate = Deferred.succeed(enteredSnapshot, undefined).pipe(
      Effect.andThen(Effect.never),
    );
    const fiber = yield* Effect.forkChild(captureText());
    yield* Deferred.await(enteredSnapshot);
    yield* Fiber.interrupt(fiber);
    assertClean(page);
  }).pipe(providePage(page), Effect.provide(TestLayer));
});

it.effect("does not capture text when the resolved tab is unavailable", () => {
  const page = makePage("text");
  page.available = false;
  return Effect.gen(function* () {
    expect(yield* Effect.flip(captureText())).toBeInstanceOf(Snapshot.PreviewTextCaptureError);
    expect(page.requests).toHaveLength(1);
    expect(page.reads()).toBe(0);
    assertClean(page);
  }).pipe(providePage(page), Effect.provide(TestLayer));
});

it.effect.each(["status", "evaluate"] as const)(
  "preserves browser recovery errors during text %s",
  (operation) =>
    Effect.gen(function* () {
      for (const ErrorClass of [
        PreviewAutomationNoAvailableHostError,
        PreviewAutomationTimeoutError,
        PreviewAutomationRequestQueueClosedError,
      ]) {
        const page = makePage("loaded text");
        const error = new ErrorClass({
          environmentId: scope.environmentId,
          ...scope.thread,
          operation,
          clientId: "text-client",
          connectionId: "text-connection",
          requestId: "text-request",
          timeoutMs: 15_000,
        });
        const original = page.broker!;
        page.broker = PreviewAutomationBroker.of({
          ...original,
          invoke: (request) =>
            request.operation === operation ? Effect.fail(error) : original.invoke(request),
        });
        expect(yield* Effect.flip(captureText().pipe(providePage(page)))).toBe(error);
        assertClean(page);
      }
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("preserves opt-in PNG saving without writing a text file", () => {
  const page = makePage("loaded text");
  return Effect.gen(function* () {
    const snapshots = yield* Snapshot.PreviewSnapshot;
    const result = yield* snapshots.withSnapshot(
      { scope, captureText: true, save: true },
      Effect.succeed,
    );
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    expect(Buffer.from(yield* fs.readFile(result.screenshotPath!)).toString()).toBe("png");
    expect(yield* fs.readDirectory(config.browserArtifactsDir)).toHaveLength(1);
    expect(result.screenshotPath).toMatch(/browser-screenshot-example-test-.*\.png$/);
    yield* readText(result.textCapture!.captureId, 0, true);
    assertClean(page);
  }).pipe(providePage(page), Effect.provide(TestLayer));
});

it.effect("keeps another owner's live capture when this owner captures or releases text", () => {
  const page = makePage("first owner's text");
  return Effect.gen(function* () {
    const snapshots = yield* Snapshot.PreviewSnapshot;
    const first = yield* captureText();
    const otherScope = {
      ...scope,
      thread: { ...scope.thread, threadId: ThreadId.make("other-thread") },
    };
    page.setText("second owner's text");
    const second = yield* snapshots.withSnapshot(
      { scope: otherScope, tabId, captureText: true },
      ({ textCapture }) => Effect.succeed(textCapture!),
    );
    expect(page.timers.size).toBe(2);
    expect((yield* readText(first.captureId)).text).toBe("first owner's text");
    expect((yield* readText(second.captureId, 0, false, otherScope)).text).toBe(
      "second owner's text",
    );
    yield* readText(first.captureId, 0, true);
    expect(page.timers.size).toBe(1);
    expect((yield* readText(second.captureId, 0, false, otherScope)).text).toBe(
      "second owner's text",
    );
    yield* readText(second.captureId, 0, true, otherScope);
    assertClean(page);
  }).pipe(providePage(page), Effect.provide(TestLayer));
});

it.effect("allows the same offset to be retried after an interrupted read", () => {
  const page = makePage("loaded ".repeat(2000));
  return Effect.gen(function* () {
    const captured = yield* captureText();
    const enteredRead = yield* Deferred.make<void>();
    page.chunkGate = Deferred.succeed(enteredRead, undefined).pipe(Effect.andThen(Effect.never));
    const fiber = yield* Effect.forkChild(readText(captured.captureId));
    yield* Deferred.await(enteredRead);
    yield* Fiber.interrupt(fiber);
    page.chunkGate = undefined;
    const retried = yield* readText(captured.captureId);
    expect(retried.text).toBe("loaded ".repeat(2000).slice(0, 4096));
    expect(retried.nextOffset).toBe(4096);
    expect(page.reads()).toBe(1);
    yield* readText(captured.captureId, 0, true);
    assertClean(page);
  }).pipe(providePage(page), Effect.provide(TestLayer));
});

it.effect("releases its memory capture when the requested PNG cannot be saved", () => {
  const page = makePage("loaded text");
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    yield* fs.writeFileString(config.browserArtifactsDir, "existing file");
    const snapshots = yield* Snapshot.PreviewSnapshot;
    const failed = yield* Effect.flip(
      snapshots.withSnapshot({ scope, captureText: true, save: true }, Effect.succeed),
    );
    expect(failed).toBeInstanceOf(Snapshot.PreviewScreenshotSaveError);
    expect(yield* fs.readFileString(config.browserArtifactsDir)).toBe("existing file");
    assertClean(page);
  }).pipe(providePage(page), Effect.provide(TestLayer));
});

it.effect("cleans an installed capture when its initial response is interrupted", () => {
  const page = makePage("loaded text");
  return Effect.gen(function* () {
    const enteredCapture = yield* Deferred.make<void>();
    page.captureGate = Deferred.succeed(enteredCapture, undefined).pipe(
      Effect.andThen(Effect.never),
    );
    const fiber = yield* Effect.forkChild(captureText());
    yield* Deferred.await(enteredCapture);
    expect(page.timers.size).toBe(1);
    yield* Fiber.interrupt(fiber);
    assertClean(page);
  }).pipe(providePage(page), Effect.provide(TestLayer));
});

it.effect("keeps the same owner's capture when its credential is renewed", () => {
  const page = makePage("loaded text");
  return Effect.gen(function* () {
    const captured = yield* captureText();
    const renewedScope = { ...scope, issuedAt: 2, requestNamespace: "renewed-request-namespace" };
    expect((yield* readText(captured.captureId, 0, false, renewedScope)).text).toBe("loaded text");
    yield* readText(captured.captureId, 0, true, renewedScope);
    assertClean(page);
  }).pipe(providePage(page), Effect.provide(TestLayer));
});
