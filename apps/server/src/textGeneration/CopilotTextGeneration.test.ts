import * as NodeServices from "@effect/platform-node/NodeServices";
import { beforeEach, expect, it } from "@effect/vitest";
import { CopilotSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { makeCopilotTextGeneration } from "./CopilotTextGeneration.ts";

const runtimeMock = vi.hoisted(() => {
  const state = {
    createdClients: [] as Array<{
      readonly input: { readonly cwd?: string; readonly baseDirectory?: string };
      readonly client: {
        readonly start: ReturnType<typeof vi.fn>;
        readonly stop: ReturnType<typeof vi.fn>;
        readonly forceStop: ReturnType<typeof vi.fn>;
        readonly createSession: ReturnType<typeof vi.fn>;
      };
    }>,
    sessionConfigs: [] as Array<unknown>,
    sessions: [] as Array<{
      readonly disconnect: ReturnType<typeof vi.fn>;
      readonly sendAndWait: ReturnType<typeof vi.fn>;
    }>,
    clientStartGate: null as Promise<void> | null,
    clientStartError: null as Error | null,
    stopErrors: [] as Error[],
    responseContent: {
      subject: "Add change",
      body: "",
    } as Record<string, unknown>,
  };

  return {
    state,
    reset() {
      state.createdClients = [];
      state.sessionConfigs = [];
      state.sessions = [];
      state.clientStartGate = null;
      state.clientStartError = null;
      state.stopErrors = [];
      state.responseContent = {
        subject: "Add change",
        body: "",
      };
    },
  };
});

vi.mock("../provider/copilotRuntime.ts", async () => {
  const actual = await vi.importActual<typeof import("../provider/copilotRuntime.ts")>(
    "../provider/copilotRuntime.ts",
  );

  return {
    ...actual,
    createCopilotClient: vi.fn(
      (input: { readonly cwd?: string; readonly baseDirectory?: string }) => {
        const start = vi.fn(async () => {
          await runtimeMock.state.clientStartGate;
          if (runtimeMock.state.clientStartError) {
            throw runtimeMock.state.clientStartError;
          }
        });
        const stop = vi.fn(async () => runtimeMock.state.stopErrors);
        const forceStop = vi.fn(async () => undefined);
        const createSession = vi.fn(async (config: unknown) => {
          runtimeMock.state.sessionConfigs.push(config);
          const sendAndWait = vi.fn(async () => ({
            data: {
              content: JSON.stringify(runtimeMock.state.responseContent),
            },
          }));
          const disconnect = vi.fn(async () => undefined);
          runtimeMock.state.sessions.push({ disconnect, sendAndWait });
          return {
            sendAndWait,
            disconnect,
          };
        });

        const client = {
          start,
          stop,
          forceStop,
          createSession,
        };
        runtimeMock.state.createdClients.push({ input, client });
        return Effect.succeed(client);
      },
    ),
  };
});

beforeEach(() => {
  runtimeMock.reset();
});

const defaultCopilotSettings: CopilotSettings = {
  enabled: true,
  binaryPath: "",
  serverUrl: "",
  customModels: [],
};

const CopilotTextGenerationTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-copilot-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(CopilotTextGenerationTestLayer)("CopilotTextGeneration", (it) => {
  it.effect("reuses a started Copilot client across git text generation requests", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeCopilotTextGeneration(defaultCopilotSettings);
      const modelSelection = createModelSelection(ProviderInstanceId.make("copilot"), "gpt-4.1");

      const first = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/copilot-text-generation",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection,
      });

      const second = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/copilot-text-generation",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection,
      });

      expect(first.subject).toBe("Add change");
      expect(second.subject).toBe("Add change");

      expect(runtimeMock.state.createdClients).toHaveLength(1);
      expect(runtimeMock.state.createdClients[0]?.input.baseDirectory).toBeUndefined();
      expect(runtimeMock.state.sessions).toHaveLength(2);

      const sharedClient = runtimeMock.state.createdClients[0]?.client;
      expect(sharedClient?.start).toHaveBeenCalledTimes(1);
      expect(sharedClient?.createSession).toHaveBeenCalledTimes(2);
      expect(sharedClient?.stop).not.toHaveBeenCalled();

      expect(runtimeMock.state.sessions[0]?.sendAndWait).toHaveBeenCalledTimes(1);
      expect(runtimeMock.state.sessions[0]?.disconnect).toHaveBeenCalledTimes(1);
      expect(runtimeMock.state.sessions[1]?.sendAndWait).toHaveBeenCalledTimes(1);
      expect(runtimeMock.state.sessions[1]?.disconnect).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("coalesces concurrent Copilot client startup", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeCopilotTextGeneration(defaultCopilotSettings);
      const modelSelection = createModelSelection(ProviderInstanceId.make("copilot"), "gpt-4.1");
      let releaseClientStart: (() => void) | undefined;
      runtimeMock.state.clientStartGate = new Promise<void>((resolve) => {
        releaseClientStart = resolve;
      });

      const request = textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/copilot-text-generation",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection,
      });
      const requestsFiber = yield* Effect.all([request, request], {
        concurrency: "unbounded",
      }).pipe(Effect.forkChild);

      for (
        let attempt = 0;
        attempt < 20 && runtimeMock.state.createdClients.length === 0;
        attempt += 1
      ) {
        yield* Effect.yieldNow;
      }
      expect(runtimeMock.state.createdClients).toHaveLength(1);

      releaseClientStart?.();
      const results = yield* Fiber.join(requestsFiber);
      expect(results.map((result) => result.subject)).toEqual(["Add change", "Add change"]);
      expect(runtimeMock.state.createdClients).toHaveLength(1);
      expect(runtimeMock.state.createdClients[0]?.client.start).toHaveBeenCalledOnce();
    }),
  );

  it.effect("stops failed clients and allows a later Copilot startup retry", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeCopilotTextGeneration(defaultCopilotSettings);
      const modelSelection = createModelSelection(ProviderInstanceId.make("copilot"), "gpt-4.1");
      runtimeMock.state.clientStartError = new Error("Copilot startup failed");
      const request = () =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/copilot-startup-failure",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection,
        });

      const firstResult = yield* request().pipe(Effect.result);
      expect(firstResult._tag).toBe("Failure");
      expect(runtimeMock.state.createdClients).toHaveLength(1);
      expect(runtimeMock.state.createdClients[0]?.client.stop).toHaveBeenCalledOnce();

      runtimeMock.state.clientStartError = null;
      const retry = yield* request();
      expect(retry.subject).toBe("Add change");
      expect(runtimeMock.state.createdClients).toHaveLength(2);
      expect(runtimeMock.state.createdClients[1]?.client.start).toHaveBeenCalledOnce();
    }),
  );

  it.effect("unblocks waiters and cleans up when shared Copilot startup is interrupted", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeCopilotTextGeneration(defaultCopilotSettings);
      const modelSelection = createModelSelection(ProviderInstanceId.make("copilot"), "gpt-4.1");
      let releaseClientStart!: () => void;
      runtimeMock.state.clientStartGate = new Promise<void>((resolve) => {
        releaseClientStart = resolve;
      });
      const request = () =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/copilot-startup-interruption",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection,
        });

      const startingFiber = yield* request().pipe(Effect.forkChild);
      for (
        let attempt = 0;
        attempt < 20 && runtimeMock.state.createdClients.length === 0;
        attempt += 1
      ) {
        yield* Effect.yieldNow;
      }
      expect(runtimeMock.state.createdClients).toHaveLength(1);

      const waitingFiber = yield* request().pipe(Effect.result, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(startingFiber);
      const waitingResult = yield* Fiber.join(waitingFiber);

      expect(waitingResult._tag).toBe("Failure");
      expect(runtimeMock.state.createdClients[0]?.client.stop).toHaveBeenCalledOnce();

      runtimeMock.state.clientStartGate = null;
      releaseClientStart();
      const retry = yield* request();
      expect(retry.subject).toBe("Add change");
      expect(runtimeMock.state.createdClients).toHaveLength(2);
    }),
  );

  it.effect("passes the configured Copilot base directory to shared clients", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeCopilotTextGeneration(defaultCopilotSettings, process.env, {
        baseDirectory: "/tmp/t3-copilot-home",
      });
      const modelSelection = createModelSelection(ProviderInstanceId.make("copilot"), "gpt-4.1");

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/copilot-home",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection,
      });

      expect(runtimeMock.state.createdClients).toHaveLength(1);
      expect(runtimeMock.state.createdClients[0]?.input.baseDirectory).toBe("/tmp/t3-copilot-home");
    }),
  );

  it.effect("passes model options to Copilot text generation sessions", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeCopilotTextGeneration(defaultCopilotSettings);
      const modelSelection = createModelSelection(ProviderInstanceId.make("copilot"), "gpt-4.1", [
        { id: "reasoningEffort", value: "high" },
        { id: "contextTier", value: "long_context" },
      ]);

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/copilot-options",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection,
      });

      expect(runtimeMock.state.sessionConfigs).toMatchObject([
        {
          model: "gpt-4.1",
          reasoningEffort: "high",
          contextTier: "long_context",
          infiniteSessions: { enabled: false },
        },
      ]);
    }),
  );

  it.effect("force stops an idle shared client after incomplete graceful cleanup", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeCopilotTextGeneration(defaultCopilotSettings);
      const modelSelection = createModelSelection(ProviderInstanceId.make("copilot"), "gpt-4.1");
      runtimeMock.state.stopErrors = [new Error("text client cleanup failed")];

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/copilot-cleanup",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection,
      });
      yield* TestClock.adjust("30 seconds");
      yield* Effect.yieldNow;

      const client = runtimeMock.state.createdClients[0]?.client;
      expect(client?.stop).toHaveBeenCalledOnce();
      expect(client?.forceStop).toHaveBeenCalledOnce();
    }),
  );

  it.effect("generates summarized thread titles through Copilot", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeCopilotTextGeneration(defaultCopilotSettings);
      const modelSelection = createModelSelection(ProviderInstanceId.make("copilot"), "gpt-4.1");
      runtimeMock.state.responseContent = {
        title: "Fix reconnect startup",
      };

      const result = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Investigate Copilot thread startup errors after reconnecting.",
        modelSelection,
      });

      expect(result.title).toBe("Fix reconnect startup");
      expect(runtimeMock.state.createdClients).toHaveLength(1);
      expect(runtimeMock.state.sessions).toHaveLength(1);
      expect(runtimeMock.state.sessions[0]?.sendAndWait).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            "Title should summarize the user's request, not restate it verbatim.",
          ),
        }),
        180_000,
      );
    }),
  );
});
