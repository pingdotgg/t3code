// @effect-diagnostics nodeBuiltinImport:off - cancellation verifies the real temp directory lifetime.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CursorSettings, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { createModelSelection } from "@t3tools/shared/model";
import { beforeEach, vi } from "vite-plus/test";

import { makeCursorTextGeneration } from "./CursorTextGeneration.ts";

const cursorSdkMock = vi.hoisted(() => ({
  create: vi.fn(),
  send: vi.fn(),
  wait: vi.fn(),
  cancel: vi.fn(),
  dispose: vi.fn(),
  status: "finished" as "running" | "finished" | "error" | "cancelled",
}));

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: cursorSdkMock.create,
  },
}));

const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const cursorSettings = decodeCursorSettings({ enabled: true });

beforeEach(() => {
  cursorSdkMock.create.mockReset();
  cursorSdkMock.send.mockReset();
  cursorSdkMock.wait.mockReset();
  cursorSdkMock.cancel.mockReset();
  cursorSdkMock.dispose.mockReset();
  cursorSdkMock.status = "finished";
  cursorSdkMock.wait.mockResolvedValue({
    id: "run-cursor-text-generation-test",
    status: "finished",
    result:
      '{"subject":"Add generated commit message","body":"- verify cursor sdk text generation"}',
  });
  cursorSdkMock.send.mockResolvedValue({
    id: "run-cursor-text-generation-test",
    agentId: "agent-cursor-text-generation-test",
    supports: (operation: string) => operation === "cancel" || operation === "wait",
    unsupportedReason: () => undefined,
    wait: cursorSdkMock.wait,
    cancel: cursorSdkMock.cancel,
    get status() {
      return cursorSdkMock.status;
    },
  });
  cursorSdkMock.create.mockResolvedValue({
    agentId: "agent-cursor-text-generation-test",
    send: cursorSdkMock.send,
    close: vi.fn(),
    reload: vi.fn(),
    listArtifacts: vi.fn(),
    downloadArtifact: vi.fn(),
    [Symbol.asyncDispose]: cursorSdkMock.dispose,
  });
});

it.layer(NodeServices.layer)("CursorTextGeneration", (it) => {
  it.effect("runs Cursor metadata generation in an isolated sandboxed workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/cursor-text-generation",
        stagedSummary: "M apps/server/src/textGeneration/CursorTextGeneration.ts",
        stagedPatch:
          "diff --git a/apps/server/src/textGeneration/CursorTextGeneration.ts b/apps/server/src/textGeneration/CursorTextGeneration.ts",
        modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "gpt-5.4", [
          { id: "thinking", value: "high" },
          { id: "contextWindow", value: "1m" },
          { id: "fastMode", value: true },
        ]),
      });

      expect(generated.subject).toBe("Add generated commit message");
      expect(generated.body).toBe("- verify cursor sdk text generation");

      expect(cursorSdkMock.create).toHaveBeenCalledTimes(1);
      expect(cursorSdkMock.send).toHaveBeenCalledTimes(1);
      const [options] = (cursorSdkMock.create.mock.calls as unknown as Array<[unknown]>)[0]!;
      const [prompt] = (cursorSdkMock.send.mock.calls as unknown as Array<[string]>)[0]!;
      const metadataWorkspace = (options as { local: { cwd: string } }).local.cwd;
      expect(prompt).toContain("Do not use tools, read or write files, run commands");
      expect(prompt).toContain("Staged patch:");
      expect(metadataWorkspace).toContain("t3-cursor-metadata-");
      expect(metadataWorkspace).not.toBe(process.cwd());
      expect(yield* fileSystem.exists(metadataWorkspace)).toBe(false);
      expect(options).toEqual({
        apiKey: "test-cursor-key",
        mode: "plan",
        model: {
          id: "gpt-5.4",
          params: [
            { id: "thinking", value: "high" },
            { id: "context", value: "1m" },
            { id: "fast", value: "true" },
          ],
        },
        local: {
          cwd: metadataWorkspace,
          autoReview: false,
          settingSources: [],
          sandboxOptions: { enabled: true },
          enableAgentRetries: true,
        },
      });
    }),
  );

  it.effect("removes the isolated workspace when the Cursor SDK request fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let metadataWorkspace: string | undefined;
      cursorSdkMock.create.mockImplementationOnce(async (options) => {
        metadataWorkspace = (options as { local: { cwd: string } }).local.cwd;
        throw new Error("cursor request failed");
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const error = yield* Effect.flip(
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/cursor-cleanup",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: {
            instanceId: ProviderInstanceId.make("cursor"),
            model: "composer-2",
          },
        }),
      );

      expect(error.detail).toBe("Cursor SDK request failed.");
      expect(metadataWorkspace).toBeDefined();
      expect(yield* fileSystem.exists(metadataWorkspace!)).toBe(false);
    }),
  );

  it.effect("returns on timeout and keeps the workspace until a late run settles", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const order: Array<string> = [];
      let metadataWorkspace: string | undefined;
      let resolveSend!: (run: unknown) => void;
      const pendingSend = new Promise((resolve) => {
        resolveSend = resolve;
      });
      let signalSendStarted!: () => void;
      const sendStarted = new Promise<void>((resolve) => {
        signalSendStarted = resolve;
      });
      let resolveWait!: (result: unknown) => void;
      const pendingWait = new Promise((resolve) => {
        resolveWait = resolve;
      });
      let resolveCancel!: () => void;
      const pendingCancel = new Promise<void>((resolve) => {
        resolveCancel = resolve;
      });
      let signalCancelCalled!: () => void;
      const cancelCalled = new Promise<void>((resolve) => {
        signalCancelCalled = resolve;
      });
      let signalWaitSettled!: () => void;
      const waitSettled = new Promise<void>((resolve) => {
        signalWaitSettled = resolve;
      });
      let signalCleanupDone!: () => void;
      const cleanupDone = new Promise<void>((resolve) => {
        signalCleanupDone = resolve;
      });
      cursorSdkMock.status = "running";
      cursorSdkMock.create.mockImplementationOnce(async (options) => {
        metadataWorkspace = (options as { local: { cwd: string } }).local.cwd;
        return {
          agentId: "agent-cursor-timeout",
          send: cursorSdkMock.send,
          close: vi.fn(),
          reload: vi.fn(),
          listArtifacts: vi.fn(),
          downloadArtifact: vi.fn(),
          [Symbol.asyncDispose]: async () => {
            order.push("dispose");
            expect(metadataWorkspace).toBeDefined();
            expect(NodeFS.existsSync(metadataWorkspace!)).toBe(true);
          },
        };
      });
      cursorSdkMock.send.mockImplementationOnce(() => {
        signalSendStarted();
        return pendingSend;
      });
      cursorSdkMock.wait.mockImplementation(async () => {
        const result = await pendingWait;
        order.push("wait-settled");
        signalWaitSettled();
        return result;
      });
      cursorSdkMock.cancel.mockImplementationOnce(async () => {
        order.push("cancel");
        signalCancelCalled();
        expect(metadataWorkspace).toBeDefined();
        expect(NodeFS.existsSync(metadataWorkspace!)).toBe(true);
        await pendingCancel;
        cursorSdkMock.status = "cancelled";
      });
      const trackingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        remove: (path, options) =>
          fileSystem.remove(path, options).pipe(Effect.tap(() => Effect.sync(signalCleanupDone))),
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      }).pipe(Effect.provideService(FileSystem.FileSystem, trackingFileSystem));

      const fiber = yield* textGeneration
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/cursor-timeout",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: {
            instanceId: ProviderInstanceId.make("cursor"),
            model: "composer-2",
          },
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => sendStarted);
      yield* TestClock.adjust(180_000);
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);

      expect(error.detail).toBe("Cursor SDK request timed out.");
      expect(metadataWorkspace).toBeDefined();
      expect(yield* fileSystem.exists(metadataWorkspace!)).toBe(true);

      resolveSend({
        id: "run-cursor-timeout",
        agentId: "agent-cursor-timeout",
        supports: (operation: string) => operation === "cancel" || operation === "wait",
        unsupportedReason: () => undefined,
        wait: cursorSdkMock.wait,
        cancel: cursorSdkMock.cancel,
        get status() {
          return cursorSdkMock.status;
        },
      });
      yield* Effect.promise(() => cancelCalled);
      expect(order).toEqual(["cancel"]);
      expect(yield* fileSystem.exists(metadataWorkspace!)).toBe(true);

      resolveWait({ id: "run-cursor-timeout", status: "cancelled" });
      yield* Effect.promise(() => waitSettled);
      expect(yield* fileSystem.exists(metadataWorkspace!)).toBe(true);

      resolveCancel();
      yield* Effect.promise(() => cleanupDone);
      expect(order).toEqual(["cancel", "wait-settled", "dispose"]);
      expect(yield* fileSystem.exists(metadataWorkspace!)).toBe(false);
    }),
  );

  it.effect("keeps an unsettled workspace when the owning service scope closes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const ownerScope = yield* Scope.make();
      let metadataWorkspace: string | undefined;
      yield* Effect.addFinalizer(() =>
        metadataWorkspace === undefined
          ? Effect.void
          : fileSystem
              .remove(metadataWorkspace, { recursive: true, force: true })
              .pipe(Effect.ignore),
      );
      yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
      let resolveSend!: (run: unknown) => void;
      const pendingSend = new Promise((resolve) => {
        resolveSend = resolve;
      });
      let signalSendCalled!: () => void;
      const sendCalled = new Promise<void>((resolve) => {
        signalSendCalled = resolve;
      });
      let signalCancelCalled!: () => void;
      const cancelCalled = new Promise<void>((resolve) => {
        signalCancelCalled = resolve;
      });
      let signalDisposeDone!: () => void;
      const disposeDone = new Promise<void>((resolve) => {
        signalDisposeDone = resolve;
      });
      cursorSdkMock.status = "running";
      cursorSdkMock.create.mockImplementationOnce(async (options) => {
        metadataWorkspace = (options as { local: { cwd: string } }).local.cwd;
        return {
          agentId: "agent-cursor-scope-close",
          send: cursorSdkMock.send,
          close: vi.fn(),
          reload: vi.fn(),
          listArtifacts: vi.fn(),
          downloadArtifact: vi.fn(),
          [Symbol.asyncDispose]: async () => {
            signalDisposeDone();
          },
        };
      });
      cursorSdkMock.send.mockImplementationOnce(() => {
        signalSendCalled();
        return pendingSend;
      });
      cursorSdkMock.cancel.mockImplementationOnce(async () => {
        cursorSdkMock.status = "cancelled";
        signalCancelCalled();
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      }).pipe(Effect.provideService(Scope.Scope, ownerScope));

      const caller = yield* textGeneration
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/cursor-scope-close",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: {
            instanceId: ProviderInstanceId.make("cursor"),
            model: "composer-2",
          },
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => sendCalled);

      yield* Scope.close(ownerScope, Exit.void);
      const callerExit = yield* Fiber.await(caller);
      expect(Exit.hasInterrupts(callerExit)).toBe(true);
      expect(metadataWorkspace).toBeDefined();
      expect(yield* fileSystem.exists(metadataWorkspace!)).toBe(true);

      resolveSend({
        id: "run-cursor-scope-close",
        agentId: "agent-cursor-scope-close",
        supports: (operation: string) => operation === "cancel" || operation === "wait",
        unsupportedReason: () => undefined,
        wait: cursorSdkMock.wait,
        cancel: cursorSdkMock.cancel,
        get status() {
          return cursorSdkMock.status;
        },
      });
      yield* Effect.promise(() => cancelCalled);
      yield* Effect.promise(() => disposeDone);
      expect(yield* fileSystem.exists(metadataWorkspace!)).toBe(true);
    }),
  );

  it.effect("keeps successful metadata when workspace removal fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let metadataWorkspace: string | undefined;
      cursorSdkMock.create.mockImplementationOnce(async (options) => {
        metadataWorkspace = (options as { local: { cwd: string } }).local.cwd;
        return {
          agentId: "agent-cursor-cleanup-failure",
          send: cursorSdkMock.send,
          close: vi.fn(),
          reload: vi.fn(),
          listArtifacts: vi.fn(),
          downloadArtifact: vi.fn(),
          [Symbol.asyncDispose]: cursorSdkMock.dispose,
        };
      });
      const removeFailure = new Error("forced workspace cleanup failure");
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        remove: () => Effect.fail(removeFailure as never),
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      }).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem));

      const generated = yield* textGeneration
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/cursor-cleanup-failure",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: {
            instanceId: ProviderInstanceId.make("cursor"),
            model: "composer-2",
          },
        })
        .pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              metadataWorkspace === undefined
                ? Effect.void
                : fileSystem.remove(metadataWorkspace, { recursive: true, force: true }),
            ).pipe(Effect.orDie),
          ),
        );

      expect(generated.subject).toBe("Add generated commit message");
      expect(generated.body).toBe("- verify cursor sdk text generation");
    }),
  );

  it.effect("accepts json objects with extra assistant text around them", () =>
    Effect.gen(function* () {
      cursorSdkMock.wait.mockResolvedValueOnce({
        id: "run-cursor-text-generation-test",
        status: "finished",
        result:
          'Sure, here is the JSON:\n```json\n{\n  "subject": "Update README dummy comment with attribution and date",\n  "body": ""\n}\n```\nDone.',
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/cursor-noisy-json",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2",
        },
      });

      expect(generated.subject).toBe("Update README dummy comment with attribution and date");
      expect(generated.body).toBe("");
    }),
  );

  it.effect("generates thread titles through Cursor SDK text generation", () =>
    Effect.gen(function* () {
      cursorSdkMock.wait.mockResolvedValueOnce({
        id: "run-cursor-title-generation-test",
        status: "finished",
        result: '{"title":"\\"Trim reconnect spinner status after resume.\\""}',
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Fix the reconnect spinner after a resumed session.",
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2",
        },
      });

      expect(generated.title).toBe("Trim reconnect spinner status after resume.");
    }),
  );

  it.effect("requires CURSOR_API_KEY before calling the SDK", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {});

      const error = yield* Effect.flip(
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/cursor-api-key",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: {
            instanceId: ProviderInstanceId.make("cursor"),
            model: "composer-2",
          },
        }),
      );

      expect(error.detail).toBe(
        "Cursor API key is required. Add CURSOR_API_KEY in provider settings.",
      );
      expect(cursorSdkMock.create).not.toHaveBeenCalled();
    }),
  );
});
