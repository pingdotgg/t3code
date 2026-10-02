import { describe, expect, it } from "@effect/vitest";
import {
  type AssetCreateUrlResult,
  AssetWorkspaceAssetNotFoundError,
  AssetWorkspaceAssetInspectionError,
  AssetWorkspaceContextNotFoundError,
  EnvironmentAuthorizationError,
  EnvironmentId,
  type ProjectCloneSnapshot,
  ProjectId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { createProjectFaviconCache } from "../projectFaviconCache.ts";
import {
  createAssetEnvironmentAtoms,
  createProjectFaviconUrlAtomFamily,
  InvalidAssetCollectionKeyError,
  parseAssetCollectionKey,
} from "./assets.ts";

describe("asset collection keys", () => {
  it("preserves malformed JSON and its native cause", () => {
    const key = "not-json";
    let error: unknown;

    try {
      parseAssetCollectionKey(key);
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(InvalidAssetCollectionKeyError);
    expect(error).toMatchObject({ key, cause: expect.any(SyntaxError) });
  });

  it("rejects invalid asset collection shapes", () => {
    const key = JSON.stringify(["environment-1", [{ _tag: "unknown" }]]);

    expect(() => parseAssetCollectionKey(key)).toThrowError(InvalidAssetCollectionKeyError);
  });
});

describe("createAssetEnvironmentAtoms", () => {
  for (const scenario of [
    { name: "missing video", path: "/tmp/clip.mp4", fallback: true },
    { name: "literal filename characters", path: "/tmp/frame#one?two.png", fallback: true },
    { name: "windows path", path: "C:\\Users\\demo\\clip.mp4", fallback: true },
    { name: "inspection failure", path: "/tmp/clip.mp4", error: "inspection", fallback: true },
    { name: "foreign thread", path: "/tmp/clip.mp4", error: "context", fallback: true },
    { name: "remote success", path: "/tmp/clip.mp4", success: true },
    { name: "relative path", path: "clip.mp4" },
    { name: "no primary", path: "/tmp/clip.mp4", primary: "none" },
    { name: "primary reconnect", path: "/tmp/frame.png", primary: "reconnecting" },
    { name: "same environment", path: "/tmp/clip.mp4", primary: "same" },
    { name: "non-media", path: "/tmp/report.html" },
    { name: "authorization failure", path: "/tmp/clip.mp4", error: "auth" },
  ]) {
    it.effect(`uses the correct environment for ${scenario.name}`, () =>
      Effect.gen(function* () {
        const remoteId = EnvironmentId.make("remote");
        const localId = EnvironmentId.make("local");
        const resource = {
          _tag: "media-file" as const,
          threadId: ThreadId.make("foreign-thread"),
          path: scenario.path,
        };
        const error =
          scenario.error === "auth"
            ? new EnvironmentAuthorizationError({
                message: "denied",
                requiredScope: "orchestration:read",
              })
            : scenario.error === "inspection"
              ? new AssetWorkspaceAssetInspectionError({ resource, cause: new Error("unreadable") })
              : scenario.error === "context"
                ? new AssetWorkspaceContextNotFoundError({ resource })
                : new AssetWorkspaceAssetNotFoundError({ resource });
        const calls: EnvironmentId[] = [];
        const supervisors = new Map<
          EnvironmentId,
          EnvironmentSupervisor.EnvironmentSupervisor["Service"]
        >();
        for (const environmentId of [remoteId, localId]) {
          const client = {
            [WS_METHODS.assetsCreateUrl]: () => {
              calls.push(environmentId);
              return environmentId === remoteId && !scenario.success
                ? Effect.fail(error)
                : Effect.succeed({
                    relativeUrl: `/api/assets/${environmentId}/media`,
                    expiresAt: 999999,
                  });
            },
          } as unknown as WsRpcProtocolClient;
          const session = { client } as RpcSession;
          supervisors.set(
            environmentId,
            EnvironmentSupervisor.EnvironmentSupervisor.of({
              target: new PrimaryConnectionTarget({
                environmentId,
                label: environmentId,
                httpBaseUrl: `https://${environmentId}.test`,
                wsBaseUrl: `wss://${environmentId}.test`,
              }),
              state: yield* SubscriptionRef.make<SupervisorConnectionState>({
                ...AVAILABLE_CONNECTION_STATE,
                phase: "connected" as const,
              }),
              session: yield* SubscriptionRef.make(Option.some(session)),
              prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
              connect: Effect.void,
              disconnect: Effect.void,
              retryNow: Effect.void,
            }),
          );
        }
        const environments = EnvironmentRegistry.EnvironmentRegistry.of({
          run: (id, effect) =>
            Effect.provideService(
              effect,
              EnvironmentSupervisor.EnvironmentSupervisor,
              supervisors.get(id)!,
            ),
          followStream: (id, stream) =>
            Stream.provideService(
              stream,
              EnvironmentSupervisor.EnvironmentSupervisor,
              supervisors.get(id)!,
            ),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const localTarget = {
          environmentId: scenario.primary === "same" ? remoteId : localId,
          httpBaseUrl: "https://local.test",
        };
        const localEnvironment = Atom.make<typeof localTarget | null>(
          scenario.primary === "none" || scenario.primary === "reconnecting" ? null : localTarget,
        );
        const assets = createAssetEnvironmentAtoms(
          Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments)),
          localEnvironment,
        );
        const query = assets.createUrl({ environmentId: remoteId, input: { resource } });
        const result = AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
        if (scenario.fallback || scenario.success) {
          expect((yield* result).relativeUrl).toBe(
            scenario.fallback
              ? "https://local.test/api/assets/local/media"
              : "/api/assets/remote/media",
          );
        } else {
          expect(yield* Effect.flip(result)).toEqual(error);
        }
        expect(calls).toEqual(scenario.fallback ? [remoteId, localId] : [remoteId]);
        if (scenario.primary === "reconnecting") {
          registry.set(localEnvironment, localTarget);
          expect((yield* result).relativeUrl).toBe("https://local.test/api/assets/local/media");
          expect(calls).toEqual([remoteId, remoteId, localId]);
        }
      }).pipe(Effect.scoped),
    );
  }

  it("keys asset URL queries by environment and resource", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry.EnvironmentRegistry,
      never
    >;
    const assets = createAssetEnvironmentAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const originalTarget = {
      environmentId,
      input: {
        resource: {
          _tag: "project-favicon" as const,
          cwd: "/repo/original",
        },
      },
    };

    expect(assets.createUrl(originalTarget)).toBe(
      assets.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "project-favicon",
            cwd: "/repo/original",
          },
        },
      }),
    );
    expect(
      assets.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "project-favicon",
            cwd: "/repo/next",
          },
        },
      }),
    ).not.toBe(assets.createUrl(originalTarget));
    expect(
      assets.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "project-favicon",
            cwd: "/repo/original",
            path: "brand/icon.svg",
          },
        },
      }),
    ).not.toBe(assets.createUrl(originalTarget));
    expect(
      assets.createUrl({
        environmentId: EnvironmentId.make("environment-2"),
        input: originalTarget.input,
      }),
    ).not.toBe(assets.createUrl(originalTarget));
  });

  it("keys collections while preserving independent resource queries", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry.EnvironmentRegistry,
      never
    >;
    const assets = createAssetEnvironmentAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const resources = [
      { _tag: "attachment" as const, attachmentId: "attachment-1" },
      { _tag: "attachment" as const, attachmentId: "attachment-2" },
    ];

    expect(assets.createUrls({ environmentId, resources })).toBe(
      assets.createUrls({
        environmentId,
        resources: resources.map((resource) => ({ ...resource })),
      }),
    );
    expect(
      assets.createUrls({
        environmentId,
        resources: [...resources].toReversed(),
      }),
    ).not.toBe(assets.createUrls({ environmentId, resources }));
  });
});

describe("project favicon URL cache", () => {
  it("renders a persisted thumbnail immediately in a fresh registry and refreshes it remotely", async () => {
    const image = "data:image/png;base64,aWNvbg==";
    const replacement = "data:image/png;base64,bmV3";
    const records = new Map<string, unknown>();
    const storage = {
      list: async () => [...records.values()],
      put: async (key: string, entry: unknown) => {
        records.set(key, entry);
      },
      remove: async (key: string) => {
        records.delete(key);
      },
    };
    const target = { environmentId: EnvironmentId.make("remote"), cwd: "/workspace" };
    const previousCache = createProjectFaviconCache({ storage, load: async () => image });
    await previousCache.resolve(
      target,
      "https://remote.test/api/assets/old/v1-icon.png",
      new AbortController().signal,
    );
    await previousCache.flush();
    const cache = createProjectFaviconCache({ storage, load: async () => replacement });
    await cache.hydrate();
    const registry = AtomRegistry.make();
    const result = Atom.make<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>>(
      AsyncResult.initial(),
    );
    const connection = Atom.make<Option.Option<{ httpBaseUrl: string }>>(Option.none());
    const favicon = createProjectFaviconUrlAtomFamily({
      createUrl: () => result,
      preparedConnection: () => connection,
      imageCache: cache,
    })(target);
    const unmount = registry.mount(favicon);
    try {
      expect(registry.get(favicon)).toBe(image);
      let unsubscribe = () => {};
      const refreshed = new Promise<void>((resolve) => {
        unsubscribe = registry.subscribe(favicon, (value) => {
          if (value === replacement) resolve();
        });
      });
      registry.set(connection, Option.some({ httpBaseUrl: "https://remote.test" }));
      registry.set(
        result,
        AsyncResult.success({
          relativeUrl: "/api/assets/new/v2-icon.png",
          expiresAt: 4_000_000_000_000,
        }),
      );
      expect(registry.get(favicon)).toBe(image);
      await refreshed;
      unsubscribe();
      expect(registry.get(favicon)).toBe(replacement);
      registry.set(connection, Option.none());
      registry.set(result, AsyncResult.failure(Cause.die("offline")));
      expect(registry.get(favicon)).toBe(replacement);
    } finally {
      unmount();
      registry.dispose();
    }
  });

  it("retains icons across outages and remounts, then accepts refreshed and missing icons", () => {
    const registry = AtomRegistry.make();
    const result = Atom.make<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>>(
      AsyncResult.initial(),
    );
    const connection = Atom.make(Option.some({ httpBaseUrl: "https://remote.test" }));
    const favicon = createProjectFaviconUrlAtomFamily({
      createUrl: () => result,
      preparedConnection: () => connection,
    })({ environmentId: EnvironmentId.make("remote"), cwd: "/workspace" });
    let unmount = registry.mount(favicon);
    try {
      expect(registry.get(favicon)).toBeNull();
      registry.set(
        result,
        AsyncResult.success({
          expiresAt: 4_000_000_000_000,
          relativeUrl: "/api/assets/token-a/icon.svg",
        }),
      );
      expect(registry.get(favicon)).toBe("https://remote.test/api/assets/token-a/icon.svg");

      registry.set(connection, Option.none());
      registry.set(result, AsyncResult.failure(Cause.die("disconnected")));
      expect(registry.get(favicon)).toBe("https://remote.test/api/assets/token-a/icon.svg");
      unmount();
      unmount = registry.mount(favicon);
      expect(registry.get(favicon)).toBe("https://remote.test/api/assets/token-a/icon.svg");

      registry.set(result, AsyncResult.initial());
      registry.set(connection, Option.some({ httpBaseUrl: "https://reconnected.test" }));
      expect(registry.get(favicon)).toBe("https://remote.test/api/assets/token-a/icon.svg");
      registry.set(
        result,
        AsyncResult.success({
          expiresAt: 4_000_000_000_000,
          relativeUrl: "/api/assets/token-b/icon.svg",
        }),
      );
      expect(registry.get(favicon)).toBe("https://reconnected.test/api/assets/token-b/icon.svg");

      registry.set(
        result,
        AsyncResult.success({
          expiresAt: 4_000_000_000_000,
          relativeUrl: "/api/assets/token-c/project-favicon-missing",
        }),
      );
      expect(registry.get(favicon)).toBe(
        "https://reconnected.test/api/assets/token-c/project-favicon-missing",
      );
      registry.set(connection, Option.none());
      expect(registry.get(favicon)).toBe(
        "https://reconnected.test/api/assets/token-c/project-favicon-missing",
      );
    } finally {
      unmount();
      registry.dispose();
    }
  });

  it("does not reuse another environment, workspace, or selected icon's cached URL", () => {
    const registry = AtomRegistry.make();
    const result = Atom.make<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>>(
      AsyncResult.success({
        expiresAt: 4_000_000_000_000,
        relativeUrl: "/api/assets/token/icon.svg",
      }),
    );
    const favicon = createProjectFaviconUrlAtomFamily({
      createUrl: () => result,
      preparedConnection: () => Atom.make(Option.some({ httpBaseUrl: "https://remote.test" })),
    });
    const target = { environmentId: EnvironmentId.make("remote"), cwd: "/workspace" };
    const unmount = registry.mount(favicon(target));
    try {
      expect(registry.get(favicon(target))).toBe("https://remote.test/api/assets/token/icon.svg");
      registry.set(result, AsyncResult.failure(Cause.die("disconnected")));
      expect(
        registry.get(favicon({ ...target, environmentId: EnvironmentId.make("other") })),
      ).toBeNull();
      expect(registry.get(favicon({ ...target, cwd: "/other" }))).toBeNull();
      expect(registry.get(favicon({ ...target, faviconPath: "brand.svg" }))).toBeNull();
      expect(registry.get(favicon({ ...target, faviconPath: null }))).toBe(
        "https://remote.test/api/assets/token/icon.svg",
      );
    } finally {
      unmount();
      registry.dispose();
    }
  });

  const cloning: ProjectCloneSnapshot = {
    projectId: ProjectId.make("project-cloning"),
    remoteUrl: "git@github.com:octocat/app.git",
    destinationPath: "/workspace",
    repository: null,
    phase: "running",
    stage: "receiving",
    percent: 10,
    detail: null,
    error: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    sequence: 1,
  };

  function mountClonedProjectFavicon(initialClones: ReadonlyArray<ProjectCloneSnapshot>) {
    const registry = AtomRegistry.make();
    // Stands in for the server, which reports the icon missing until the clone lands.
    const server = { lookups: 0, landed: false };
    const result = Atom.make(() => {
      server.lookups += 1;
      return AsyncResult.success({
        expiresAt: 4_000_000_000_000,
        relativeUrl: server.landed
          ? "/api/assets/token-b/v1-icon.svg"
          : "/api/assets/token-a/project-favicon-missing",
      });
    });
    const clones = Atom.make(initialClones);
    const connection = Atom.make(Option.some({ httpBaseUrl: "https://remote.test" }));
    const favicon = createProjectFaviconUrlAtomFamily({
      createUrl: () => result,
      preparedConnection: () => connection,
      projectClones: () => clones,
    })({ environmentId: EnvironmentId.make("remote"), cwd: "/workspace" });
    const unmount = registry.mount(favicon);
    return {
      registry,
      server,
      clones,
      favicon,
      dispose: () => {
        unmount();
        registry.dispose();
      },
    };
  }

  it("asks for a cloned project's icon again once its clone lands", () => {
    const { registry, server, clones, favicon, dispose } = mountClonedProjectFavicon([cloning]);
    try {
      expect(registry.get(favicon)).toBe(
        "https://remote.test/api/assets/token-a/project-favicon-missing",
      );
      // Progress, and another folder's clone landing, do not ask again.
      registry.set(clones, [
        { ...cloning, percent: 80, sequence: 2 },
        {
          ...cloning,
          projectId: ProjectId.make("project-other"),
          destinationPath: "/other",
          phase: "done",
          sequence: 3,
        },
      ]);
      expect(server.lookups).toBe(1);

      server.landed = true;
      registry.set(clones, [{ ...cloning, phase: "done", sequence: 4 }]);
      expect(registry.get(favicon)).toBe("https://remote.test/api/assets/token-b/v1-icon.svg");
      expect(server.lookups).toBe(2);
    } finally {
      dispose();
    }
  });

  it("asks again when the first clone list it sees already says done", () => {
    const { registry, server, clones, favicon, dispose } = mountClonedProjectFavicon([]);
    try {
      expect(registry.get(favicon)).toBe(
        "https://remote.test/api/assets/token-a/project-favicon-missing",
      );
      server.landed = true;
      registry.set(clones, [{ ...cloning, phase: "done", sequence: 2 }]);
      expect(registry.get(favicon)).toBe("https://remote.test/api/assets/token-b/v1-icon.svg");
    } finally {
      dispose();
    }
  });
});
