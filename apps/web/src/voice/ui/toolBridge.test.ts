import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ThreadId, VoiceOpenThreadOutput } from "@t3tools/contracts";

import { createNavigatingVoiceToolExecutor } from "./toolBridge";
import type { VoiceNavigationResult } from "../navigation";
import type { VoiceToolExecutor } from "../tools";

const DESTINATION = {
  environmentId: "env-1" as EnvironmentId,
  threadId: "thread-1" as ThreadId,
};

const openOutput = (overrides?: Partial<VoiceOpenThreadOutput>): VoiceOpenThreadOutput => ({
  environment: { environmentId: DESTINATION.environmentId, status: "ok" },
  acknowledged: false,
  destination: DESTINATION,
  ...overrides,
});

interface ToolsCalls {
  readonly calls: Array<{ readonly tool: string; readonly input: unknown }>;
  openResult: VoiceOpenThreadOutput | undefined;
  openError: Error | undefined;
}

const makeTools = (): ToolsCalls & VoiceToolExecutor => {
  const executor = {
    calls: [] as Array<{ readonly tool: string; readonly input: unknown }>,
    openResult: undefined as VoiceOpenThreadOutput | undefined,
    openError: undefined as Error | undefined,
    async discoverEnvironments() {
      executor.calls.push({ tool: "discoverEnvironments", input: undefined });
      return { environments: [] };
    },
    async discoverProjects(input) {
      executor.calls.push({ tool: "discoverProjects", input });
      return { environment: { environmentId: input.environmentId, status: "ok" }, projects: [] };
    },
    async listModels(input) {
      executor.calls.push({ tool: "listModels", input });
      return {
        environment: { environmentId: input.environmentId, status: "ok" },
        providers: [],
      };
    },
    async searchThreads(input) {
      executor.calls.push({ tool: "searchThreads", input });
      return { perEnvironment: [] };
    },
    async readThread(input) {
      executor.calls.push({ tool: "readThread", input });
      return { environment: { environmentId: input.environmentId, status: "ok" } };
    },
    async readProject(input) {
      executor.calls.push({ tool: "readProject", input });
      return {
        environment: { environmentId: input.environmentId, status: "ok" },
        recentThreads: [],
      };
    },
    async openThread(input) {
      executor.calls.push({ tool: "openThread", input });
      if (executor.openError !== undefined) {
        throw executor.openError;
      }
      return executor.openResult ?? openOutput();
    },
    async startThread(input) {
      executor.calls.push({ tool: "startThread", input });
      throw new Error("startThread is not part of this fixture");
    },
    async continueThread(input) {
      executor.calls.push({ tool: "continueThread", input });
      throw new Error("continueThread is not part of this fixture");
    },
    async observeThread(input) {
      executor.calls.push({ tool: "observeThread", input });
      throw new Error("observeThread is not part of this fixture");
    },
    async listControls(input) {
      executor.calls.push({ tool: "listControls", input });
      return { controls: [] };
    },
    async clickControl(input) {
      executor.calls.push({ tool: "clickControl", input });
      return { controlId: input.controlId, state: "activated" as const };
    },
  } as ToolsCalls & VoiceToolExecutor;
  return executor;
};

const makeNavigator = (result: VoiceNavigationResult) => {
  const destinations: Array<unknown> = [];
  return {
    destinations,
    navigateToThread: async (destination: unknown) => {
      destinations.push(destination);
      return result;
    },
  };
};

describe("navigating voice tool executor", () => {
  it("dispatches non-navigation tools to the per-tool executor by bare name", async () => {
    const tools = makeTools();
    const navigator = makeNavigator({ status: "acknowledged", destination: DESTINATION });
    const executor = createNavigatingVoiceToolExecutor({
      tools,
      navigator: { navigateToThread: navigator.navigateToThread },
    });

    await executor.execute("voice.searchThreads", { query: "macroscope" });
    await executor.execute("discoverEnvironments", {});
    await executor.execute("voice.listControls", { query: "settings" });
    await executor.execute("voice.clickControl", { controlId: "button#1:Settings" });

    const searched = tools.calls.find((call) => call.tool === "searchThreads");
    expect(searched?.input).toEqual({ query: "macroscope" });
    expect(tools.calls.some((call) => call.tool === "discoverEnvironments")).toBe(true);
    expect(tools.calls.find((call) => call.tool === "listControls")?.input).toEqual({
      query: "settings",
    });
    expect(tools.calls.find((call) => call.tool === "clickControl")?.input).toEqual({
      controlId: "button#1:Settings",
    });
    expect(navigator.destinations).toHaveLength(0);
  });

  it("flips acknowledged to true only after the navigator confirms the landing", async () => {
    const tools = makeTools();
    tools.openResult = openOutput();
    const navigator = makeNavigator({ status: "acknowledged", destination: DESTINATION });
    const executor = createNavigatingVoiceToolExecutor({
      tools,
      navigator: { navigateToThread: navigator.navigateToThread },
    });

    const output = (await executor.execute("voice.openThread", {
      environmentId: DESTINATION.environmentId,
      threadId: DESTINATION.threadId,
    })) as VoiceOpenThreadOutput;

    expect(output.acknowledged).toBe(true);
    expect(output.destination).toEqual(DESTINATION);
    expect(output.environment.status).toBe("ok");
    expect(navigator.destinations).toEqual([DESTINATION]);
  });

  it("reports a navigation failure in-band on the environment outcome", async () => {
    const tools = makeTools();
    tools.openResult = openOutput();
    const navigator = makeNavigator({
      status: "failed",
      error: {
        code: "thread_not_found",
        message: "the route redirected away",
        environmentId: DESTINATION.environmentId,
        threadId: DESTINATION.threadId,
      },
    });
    const executor = createNavigatingVoiceToolExecutor({
      tools,
      navigator: { navigateToThread: navigator.navigateToThread },
    });

    const output = (await executor.execute("voice.openThread", {
      environmentId: DESTINATION.environmentId,
      threadId: DESTINATION.threadId,
    })) as VoiceOpenThreadOutput;

    expect(output.acknowledged).toBe(false);
    expect(output.environment.status).toBe("error");
    expect(output.environment.error?.code).toBe("thread_not_found");
  });

  it("returns unacknowledged without an error when a newer navigation superseded this one", async () => {
    const tools = makeTools();
    tools.openResult = openOutput();
    const navigator = makeNavigator({ status: "superseded" });
    const executor = createNavigatingVoiceToolExecutor({
      tools,
      navigator: { navigateToThread: navigator.navigateToThread },
    });

    const output = (await executor.execute("voice.openThread", {
      environmentId: DESTINATION.environmentId,
      threadId: DESTINATION.threadId,
    })) as VoiceOpenThreadOutput;

    expect(output.acknowledged).toBe(false);
    expect(output.environment.status).toBe("ok");
  });

  it("returns the tool result unchanged when the tool already failed in-band", async () => {
    const tools = makeTools();
    tools.openResult = openOutput({
      environment: {
        environmentId: DESTINATION.environmentId,
        status: "error",
        error: {
          code: "thread_not_found",
          message: "Thread was not found.",
          environmentId: DESTINATION.environmentId,
          threadId: DESTINATION.threadId,
        },
      },
      destination: undefined,
    });
    const navigator = makeNavigator({ status: "acknowledged", destination: DESTINATION });
    const executor = createNavigatingVoiceToolExecutor({
      tools,
      navigator: { navigateToThread: navigator.navigateToThread },
    });

    const output = (await executor.execute("voice.openThread", {
      environmentId: DESTINATION.environmentId,
      threadId: DESTINATION.threadId,
    })) as VoiceOpenThreadOutput;

    expect(output.acknowledged).toBe(false);
    expect(output.environment.status).toBe("error");
    expect(navigator.destinations).toHaveLength(0);
  });

  it("propagates tool rejections (whole-tool failures) to the live client", async () => {
    const tools = makeTools();
    tools.openError = new Error("shell read failed");
    const navigator = makeNavigator({ status: "acknowledged", destination: DESTINATION });
    const executor = createNavigatingVoiceToolExecutor({
      tools,
      navigator: { navigateToThread: navigator.navigateToThread },
    });

    await expect(
      executor.execute("voice.openThread", {
        environmentId: DESTINATION.environmentId,
        threadId: DESTINATION.threadId,
      }),
    ).rejects.toThrow("shell read failed");
    expect(navigator.destinations).toHaveLength(0);
  });
});
