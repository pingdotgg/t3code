import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { CopilotSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { beforeEach, expect, vi } from "vitest";

import { ServerConfig } from "../config.ts";
import { makeCopilotTextGeneration } from "./CopilotTextGeneration.ts";

const runtimeMock = vi.hoisted(() => {
  const state = {
    createdClients: [] as Array<{
      readonly input: { readonly cwd?: string };
      readonly client: {
        readonly start: ReturnType<typeof vi.fn>;
        readonly stop: ReturnType<typeof vi.fn>;
        readonly createSession: ReturnType<typeof vi.fn>;
      };
    }>,
    sessions: [] as Array<{
      readonly disconnect: ReturnType<typeof vi.fn>;
      readonly sendAndWait: ReturnType<typeof vi.fn>;
    }>,
  };

  return {
    state,
    reset() {
      state.createdClients = [];
      state.sessions = [];
    },
  };
});

vi.mock("../provider/copilotRuntime.ts", async () => {
  const actual = await vi.importActual<typeof import("../provider/copilotRuntime.ts")>(
    "../provider/copilotRuntime.ts",
  );

  return {
    ...actual,
    createCopilotClient: vi.fn((input: { readonly cwd?: string }) => {
      const start = vi.fn(async () => undefined);
      const stop = vi.fn(async () => undefined);
      const createSession = vi.fn(async () => {
        const sendAndWait = vi.fn(async () => ({
          data: {
            content: JSON.stringify({
              subject: "Add change",
              body: "",
            }),
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
        createSession,
      };
      runtimeMock.state.createdClients.push({ input, client });
      return client;
    }),
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
});
