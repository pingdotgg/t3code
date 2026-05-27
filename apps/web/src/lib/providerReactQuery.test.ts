import {
  EnvironmentId,
  ProviderDriverKind,
  ThreadId,
  type EnvironmentApi,
} from "@t3tools/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  diffStateQueryOptions,
  providerCommandsQueryOptions,
  providerQueryKeys,
} from "./providerReactQuery";
import * as environmentApi from "../environmentApi";

const threadId = ThreadId.make("thread-id");
const environmentId = EnvironmentId.make("environment-local");
const copilotDriver = ProviderDriverKind.make("copilot");

function mockNativeApi(input: {
  getTurnDiffState: ReturnType<typeof vi.fn>;
  getFullThreadDiffState: ReturnType<typeof vi.fn>;
  listProviderCommands?: ReturnType<typeof vi.fn>;
}) {
  vi.spyOn(environmentApi, "ensureEnvironmentApi").mockReturnValue({
    server: {
      listProviderCommands: input.listProviderCommands ?? vi.fn(),
    },
    orchestration: {
      getTurnDiffState: input.getTurnDiffState,
      getFullThreadDiffState: input.getFullThreadDiffState,
    },
  } as unknown as EnvironmentApi);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("providerCommandsQueryOptions", () => {
  it("caches and forwards provider command lookups by environment, provider, and cwd", async () => {
    const listProviderCommands = vi.fn().mockResolvedValue({
      commands: [{ name: "review", description: "Review changes" }],
    });
    mockNativeApi({
      getTurnDiffState: vi.fn(),
      getFullThreadDiffState: vi.fn(),
      listProviderCommands,
    });

    const options = providerCommandsQueryOptions({
      environmentId,
      provider: copilotDriver,
      cwd: "/repo/project",
    });

    const queryClient = new QueryClient();
    await expect(queryClient.fetchQuery(options)).resolves.toEqual({
      commands: [{ name: "review", description: "Review changes" }],
    });

    expect(options.queryKey).toEqual([
      "providers",
      "commands",
      environmentId,
      copilotDriver,
      "/repo/project",
    ]);
    expect(listProviderCommands).toHaveBeenCalledWith({
      provider: copilotDriver,
      cwd: "/repo/project",
    });
  });
});

describe("providerQueryKeys.diffState", () => {
  it("includes cacheScope so reused turn counts do not collide", () => {
    const baseInput = {
      environmentId,
      threadId,
      fromTurnCount: 1,
      toTurnCount: 2,
    } as const;

    expect(
      providerQueryKeys.diffState({
        ...baseInput,
        cacheScope: "turn:old-turn",
      }),
    ).not.toEqual(
      providerQueryKeys.diffState({
        ...baseInput,
        cacheScope: "turn:new-turn",
      }),
    );
  });

  it("includes diff kind and scope so selected turn and snapshot caches do not collide", () => {
    const baseInput = {
      environmentId,
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      cacheScope: "turn:first",
    } as const;

    expect(
      providerQueryKeys.diffState({
        ...baseInput,
        kind: "turn",
        scope: "turn",
      }),
    ).not.toEqual(
      providerQueryKeys.diffState({
        ...baseInput,
        kind: "turn",
        scope: "snapshot",
      }),
    );
    expect(
      providerQueryKeys.diffState({
        ...baseInput,
        kind: "turn",
        scope: "turn",
      }),
    ).not.toEqual(
      providerQueryKeys.diffState({
        ...baseInput,
        kind: "conversation",
        scope: "snapshot",
      }),
    );
  });
});

describe("diffStateQueryOptions", () => {
  it("forwards checkpoint range to the provider API", async () => {
    const getTurnDiffState = vi
      .fn()
      .mockResolvedValue({ _tag: "ready", snapshot: { patch: "patch" } });
    const getFullThreadDiffState = vi.fn().mockResolvedValue({
      _tag: "ready",
      snapshot: { patch: "patch" },
    });
    mockNativeApi({ getTurnDiffState, getFullThreadDiffState });

    const options = diffStateQueryOptions({
      environmentId,
      threadId,
      fromTurnCount: 3,
      toTurnCount: 4,
      kind: "turn",
      scope: "turn",
      cacheScope: "turn:abc",
    });

    const queryClient = new QueryClient();
    await queryClient.fetchQuery(options);

    expect(getTurnDiffState).toHaveBeenCalledWith({
      threadId,
      fromTurnCount: 3,
      toTurnCount: 4,
      scope: "turn",
    });
    expect(getFullThreadDiffState).not.toHaveBeenCalled();
  });

  it("uses explicit full thread diff API when range starts from zero", async () => {
    const getTurnDiffState = vi
      .fn()
      .mockResolvedValue({ _tag: "ready", snapshot: { patch: "patch" } });
    const getFullThreadDiffState = vi.fn().mockResolvedValue({
      _tag: "ready",
      snapshot: { patch: "patch" },
    });
    mockNativeApi({ getTurnDiffState, getFullThreadDiffState });

    const options = diffStateQueryOptions({
      environmentId,
      threadId,
      fromTurnCount: 0,
      toTurnCount: 2,
      kind: "conversation",
      cacheScope: "thread:all",
    });

    const queryClient = new QueryClient();
    await queryClient.fetchQuery(options);

    expect(getFullThreadDiffState).toHaveBeenCalledWith({
      threadId,
      toTurnCount: 2,
    });
    expect(getTurnDiffState).not.toHaveBeenCalled();
  });

  it("uses turn diff API for an explicitly selected first turn", async () => {
    const getTurnDiffState = vi
      .fn()
      .mockResolvedValue({ _tag: "ready", snapshot: { patch: "patch" } });
    const getFullThreadDiffState = vi.fn().mockResolvedValue({
      _tag: "ready",
      snapshot: { patch: "patch" },
    });
    mockNativeApi({ getTurnDiffState, getFullThreadDiffState });

    const options = diffStateQueryOptions({
      environmentId,
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      kind: "turn",
      scope: "turn",
      cacheScope: "turn:first:turn",
    });

    const queryClient = new QueryClient();
    await queryClient.fetchQuery(options);

    expect(getTurnDiffState).toHaveBeenCalledWith({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      scope: "turn",
    });
    expect(getFullThreadDiffState).not.toHaveBeenCalled();
  });

  it("fails fast on invalid range and does not call provider RPC", async () => {
    const getTurnDiffState = vi
      .fn()
      .mockResolvedValue({ _tag: "ready", snapshot: { patch: "patch" } });
    const getFullThreadDiffState = vi.fn().mockResolvedValue({
      _tag: "ready",
      snapshot: { patch: "patch" },
    });
    mockNativeApi({ getTurnDiffState, getFullThreadDiffState });

    const options = diffStateQueryOptions({
      environmentId,
      threadId,
      fromTurnCount: 4,
      toTurnCount: 3,
      kind: "turn",
      cacheScope: "turn:invalid",
    });

    const queryClient = new QueryClient();

    await expect(queryClient.fetchQuery(options)).rejects.toThrow("Diff state is unavailable.");
    expect(getTurnDiffState).not.toHaveBeenCalled();
    expect(getFullThreadDiffState).not.toHaveBeenCalled();
  });

  it("retries checkpoint-not-ready errors longer than generic failures", () => {
    const options = diffStateQueryOptions({
      environmentId,
      threadId,
      fromTurnCount: 1,
      toTurnCount: 2,
      cacheScope: "turn:abc",
    });
    const retry = options.retry;
    expect(typeof retry).toBe("function");
    if (typeof retry !== "function") {
      throw new Error("Expected retry to be a function.");
    }

    expect(retry(1, new Error("Checkpoint turn count 2 exceeds current turn count 1."))).toBe(true);
    expect(
      retry(11, new Error("Filesystem checkpoint is unavailable for turn 2 in thread thread-1.")),
    ).toBe(true);
    expect(
      retry(12, new Error("Filesystem checkpoint is unavailable for turn 2 in thread thread-1.")),
    ).toBe(false);
    expect(retry(2, new Error("Something else failed."))).toBe(true);
    expect(retry(3, new Error("Something else failed."))).toBe(false);
  });

  it("backs off longer for checkpoint-not-ready errors", () => {
    const options = diffStateQueryOptions({
      environmentId,
      threadId,
      fromTurnCount: 1,
      toTurnCount: 2,
      cacheScope: "turn:abc",
    });
    const retryDelay = options.retryDelay;
    expect(typeof retryDelay).toBe("function");
    if (typeof retryDelay !== "function") {
      throw new Error("Expected retryDelay to be a function.");
    }

    const checkpointDelay = retryDelay(
      4,
      new Error("Checkpoint turn count 2 exceeds current turn count 1."),
    );
    const genericDelay = retryDelay(4, new Error("Network failure"));

    expect(typeof checkpointDelay).toBe("number");
    expect(typeof genericDelay).toBe("number");
    expect((checkpointDelay ?? 0) > (genericDelay ?? 0)).toBe(true);
  });
});
