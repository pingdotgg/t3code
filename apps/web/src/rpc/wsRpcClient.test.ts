import type {
  GitStatusLocalResult,
  GitStatusRemoteResult,
  GitStatusStreamEvent,
} from "@t3tools/contracts";
import { CommandId, ORCHESTRATION_V2_WS_METHODS, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("./wsTransport", () => ({
  WsTransport: class WsTransport {
    dispose = vi.fn(async () => undefined);
    reconnect = vi.fn(async () => undefined);
    request = vi.fn();
    requestStream = vi.fn();
    subscribe = vi.fn(() => () => undefined);
  },
}));

import { createWsRpcClient } from "./wsRpcClient";
import { type WsTransport } from "./wsTransport";

const baseLocalStatus: GitStatusLocalResult = {
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: false,
  branch: "feature/demo",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

const baseRemoteStatus: GitStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

describe("wsRpcClient", () => {
  it("routes orchestration V2 methods through websocket transport", async () => {
    const request = vi.fn(async (connect: (client: Record<string, unknown>) => unknown) =>
      connect({
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: vi.fn(() => ({ sequence: 2 })),
        [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: vi.fn(() => ({
          thread: { id: ThreadId.make("thread-1") },
        })),
      }),
    );
    const subscribe = vi.fn(() => () => undefined);
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      request,
      requestStream: vi.fn(),
      subscribe,
    } as unknown as WsTransport;
    const client = createWsRpcClient(transport);

    const dispatchResult = await client.orchestrationV2.dispatchCommand({
      type: "run.interrupt",
      commandId: CommandId.make("cmd-1"),
      threadId: ThreadId.make("thread-1"),
      runId: RunId.make("run-1"),
    });
    client.orchestrationV2.subscribeThread(
      { threadId: ThreadId.make("thread-1") },
      () => undefined,
    );

    expect(dispatchResult).toEqual({ sequence: 2 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("reduces git status stream events into flat status snapshots", () => {
    const subscribe = vi.fn(<TValue>(_connect: unknown, listener: (value: TValue) => void) => {
      for (const event of [
        {
          _tag: "snapshot",
          local: baseLocalStatus,
          remote: null,
        },
        {
          _tag: "remoteUpdated",
          remote: baseRemoteStatus,
        },
        {
          _tag: "localUpdated",
          local: {
            ...baseLocalStatus,
            hasWorkingTreeChanges: true,
          },
        },
      ] satisfies GitStatusStreamEvent[]) {
        listener(event as TValue);
      }
      return () => undefined;
    });

    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      request: vi.fn(),
      requestStream: vi.fn(),
      subscribe,
    } satisfies Pick<
      WsTransport,
      "dispose" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);
    const listener = vi.fn();

    client.git.onStatus({ cwd: "/repo" }, listener);

    expect(listener.mock.calls).toEqual([
      [
        {
          ...baseLocalStatus,
          hasUpstream: false,
          aheadCount: 0,
          behindCount: 0,
          pr: null,
        },
      ],
      [
        {
          ...baseLocalStatus,
          ...baseRemoteStatus,
        },
      ],
      [
        {
          ...baseLocalStatus,
          ...baseRemoteStatus,
          hasWorkingTreeChanges: true,
        },
      ],
    ]);
  });
});
