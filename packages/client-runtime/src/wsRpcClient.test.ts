import type {
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { ORCHESTRATION_WS_METHODS, ThreadId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./wsTransport.ts", () => ({
  WsTransport: class WsTransport {
    dispose = vi.fn(async () => undefined);
    reconnect = vi.fn(async () => undefined);
    request = vi.fn();
    requestStream = vi.fn();
    subscribe = vi.fn(() => () => undefined);
  },
}));

import { createWsRpcClient } from "./wsRpcClient.ts";
import type { WsTransport } from "./wsTransport.ts";

const baseLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/demo",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

const baseRemoteStatus: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

describe("createWsRpcClient", () => {
  it("runs beforeReconnect before awaiting transport.reconnect", async () => {
    const order: string[] = [];
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => {
        order.push("reconnect");
      }),
      isHeartbeatFresh: vi.fn(() => true),
      request: vi.fn(),
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "isHeartbeatFresh" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport, {
      beforeReconnect: () => {
        order.push("beforeReconnect");
      },
    });

    await client.reconnect();
    expect(order).toEqual(["beforeReconnect", "reconnect"]);
  });

  it("delegates heartbeat freshness to the transport", () => {
    const isHeartbeatFresh = vi.fn(() => true);
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh,
      request: vi.fn(),
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "isHeartbeatFresh" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);

    expect(client.isHeartbeatFresh()).toBe(true);
    expect(isHeartbeatFresh).toHaveBeenCalledOnce();
  });

  it("reduces vcs status stream events into flat status snapshots", () => {
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
      ] satisfies VcsStatusStreamEvent[]) {
        listener(event as TValue);
      }
      return () => undefined;
    });

    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => true),
      request: vi.fn(),
      requestStream: vi.fn(),
      subscribe,
    } satisfies Pick<
      WsTransport,
      "dispose" | "isHeartbeatFresh" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);
    const listener = vi.fn();

    client.vcs.onStatus({ cwd: "/repo" }, listener);

    expect(listener.mock.calls).toEqual([
      [
        {
          ...baseLocalStatus,
          hasUpstream: false,
          aheadCount: 0,
          behindCount: 0,
          aheadOfDefaultCount: 0,
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

  it("tags stream subscriptions for targeted resubscribe handling", () => {
    const subscribe = vi.fn(() => () => undefined);
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => true),
      request: vi.fn(),
      requestStream: vi.fn(),
      subscribe,
    } satisfies Pick<
      WsTransport,
      "dispose" | "isHeartbeatFresh" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);
    const listener = vi.fn();

    client.terminal.onMetadata(listener);
    client.vcs.onStatus({ cwd: "/repo" }, listener);
    client.server.subscribeConfig(listener);
    client.orchestration.subscribeThread({ threadId: ThreadId.make("thread-1") }, listener);

    const subscribeCalls = subscribe.mock.calls as unknown as Array<
      readonly [unknown, unknown, { readonly tag?: string }?]
    >;
    expect(subscribeCalls.map((call) => call[2]?.tag)).toEqual([
      WS_METHODS.subscribeTerminalMetadata,
      WS_METHODS.subscribeVcsStatus,
      WS_METHODS.subscribeServerConfig,
      ORCHESTRATION_WS_METHODS.subscribeThread,
    ]);
  });
});
