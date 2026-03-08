import { RemoteHostId, WS_METHODS, type WebSocketRequest } from "@t3tools/contracts";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { REMOTE_HELPER_METHODS } from "./remote/protocol.ts";
import { createWsRouteRequest } from "./wsServer.requestRouter.ts";

function makeRemoteHost(remoteHostId: RemoteHostId) {
  return {
    id: remoteHostId,
    label: "Review Host",
    host: "198.51.100.24",
    port: 22,
    user: "devuser",
    helperCommand: "t3 remote-agent --stdio",
    helperVersion: null,
    lastConnectionAttemptAt: null,
    lastConnectionSucceededAt: null,
    lastConnectionFailedAt: null,
    lastConnectionStatus: "unknown",
    lastConnectionError: null,
  } as const;
}

function makeRouteRequest(overrides?: {
  readonly getById?: (remoteHostId: RemoteHostId) => Effect.Effect<unknown, never, never>;
  readonly call?: (
    remoteHostId: RemoteHostId,
    method: string,
    params: unknown,
  ) => Effect.Effect<unknown, never, never>;
}) {
  const remoteHelperCall =
    overrides?.call ??
    vi.fn((_remoteHostId: RemoteHostId, _method: string, _params: unknown) =>
      Effect.succeed({ cwd: "/srv/review-app", entries: [], truncated: false }),
    );
  const remoteHostGetById =
    overrides?.getById ??
    ((remoteHostId: RemoteHostId) => Effect.succeed(Option.some(makeRemoteHost(remoteHostId))));

  return {
    remoteHelperCall,
    routeRequest: createWsRouteRequest({
      checkpointDiffQuery: {
        getTurnDiff: () => Effect.die("unused"),
        getFullThreadDiff: () => Effect.die("unused"),
      } as never,
      cwd: "/workspace",
      availableEditors: ["code"],
      keybindingsConfigPath: "/state/keybindings.json",
      keybindingsManager: {
        loadConfigState: Effect.succeed({ keybindings: [], issues: [] }),
        upsertKeybindingRule: () => Effect.die("unused"),
      } as never,
      normalizeDispatchCommand: ({ command }) => Effect.succeed(command as never),
      orchestrationEngine: {
        dispatch: () => Effect.die("unused"),
        getReadModel: () => Effect.die("unused"),
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
      } as never,
      projectionReadModelQuery: {
        getSnapshot: () => Effect.die("unused"),
      } as never,
      providerStatuses: [],
      remoteHelperClient: {
        call: remoteHelperCall as never,
        testConnection: () => Effect.die("unused"),
        subscribe: () => Effect.succeed(() => {}),
      } as never,
      remoteHostRegistry: {
        list: () => Effect.die("unused"),
        getById: remoteHostGetById as never,
        upsert: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
        updateConnectionState: () => Effect.die("unused"),
      } as never,
      runtimeRouter: {
        projectSearchEntries: () => Effect.die("unused"),
        projectWriteFile: () => Effect.die("unused"),
        gitStatus: () => Effect.die("unused"),
        gitPull: () => Effect.die("unused"),
        gitRunStackedAction: () => Effect.die("unused"),
        gitListBranches: () => Effect.die("unused"),
        gitCreateWorktree: () => Effect.die("unused"),
        gitRemoveWorktree: () => Effect.die("unused"),
        gitCreateBranch: () => Effect.die("unused"),
        gitCheckout: () => Effect.die("unused"),
        gitInit: () => Effect.die("unused"),
        terminalOpen: () => Effect.die("unused"),
        terminalWrite: () => Effect.die("unused"),
        terminalResize: () => Effect.die("unused"),
        terminalClear: () => Effect.die("unused"),
        terminalRestart: () => Effect.die("unused"),
        terminalClose: () => Effect.die("unused"),
      } as never,
      failRouteRequest: (message: string) => Effect.fail(new Error(message)),
      openInEditor: () => Effect.die("unused"),
    }),
  };
}

describe("createWsRouteRequest", () => {
  it("routes remote host browsing through the browse helper method", async () => {
    const remoteHostId = RemoteHostId.makeUnsafe("host-browse");
    const remoteHelperCall = vi.fn((_remoteHostId: RemoteHostId, _method: string, _params: unknown) =>
      Effect.succeed({
        cwd: "/srv/review-app",
        entries: [{ path: "/srv/review-app/src", kind: "directory" }],
        truncated: false,
      }),
    );
    const { routeRequest } = makeRouteRequest({ call: remoteHelperCall });

    const result = await Effect.runPromise(
      routeRequest({
        id: "req-browse",
        body: {
          _tag: WS_METHODS.remoteHostsBrowse,
          remoteHostId,
          limit: 25,
        },
      } as WebSocketRequest),
    );

    expect(remoteHelperCall).toHaveBeenCalledWith(
      remoteHostId,
      REMOTE_HELPER_METHODS.workspaceBrowseEntries,
      { cwd: "~", limit: 25 },
    );
    expect(result).toEqual({
      remoteHostId,
      cwd: "/srv/review-app",
      entries: [{ path: "/srv/review-app/src", kind: "directory" }],
      truncated: false,
    });
  });

  it("routes remote host filtered browsing through the search helper method", async () => {
    const remoteHostId = RemoteHostId.makeUnsafe("host-search");
    const remoteHelperCall = vi.fn((_remoteHostId: RemoteHostId, _method: string, _params: unknown) =>
      Effect.succeed({
        entries: [{ path: "/srv/review-app/src/index.ts", kind: "file" }],
        truncated: true,
      }),
    );
    const { routeRequest } = makeRouteRequest({ call: remoteHelperCall });

    const result = await Effect.runPromise(
      routeRequest({
        id: "req-search",
        body: {
          _tag: WS_METHODS.remoteHostsBrowse,
          remoteHostId,
          path: "/srv/review-app",
          query: "index",
          limit: 10,
        },
      } as WebSocketRequest),
    );

    expect(remoteHelperCall).toHaveBeenCalledWith(
      remoteHostId,
      REMOTE_HELPER_METHODS.workspaceSearchEntries,
      { cwd: "/srv/review-app", query: "index", limit: 10 },
    );
    expect(result).toEqual({
      remoteHostId,
      cwd: "/srv/review-app",
      entries: [{ path: "/srv/review-app/src/index.ts", kind: "file" }],
      truncated: true,
    });
  });

  it("fails remote browsing requests for unknown hosts", async () => {
    const remoteHostId = RemoteHostId.makeUnsafe("host-missing");
    const { routeRequest, remoteHelperCall } = makeRouteRequest({
      getById: () => Effect.succeed(Option.none()),
    });

    await expect(
      Effect.runPromise(
        routeRequest({
          id: "req-missing",
          body: {
            _tag: WS_METHODS.remoteHostsBrowse,
            remoteHostId,
            limit: 10,
          },
        } as WebSocketRequest),
      ),
    ).rejects.toThrow(`Remote host '${remoteHostId}' was not found.`);
    expect(remoteHelperCall).not.toHaveBeenCalled();
  });
});
