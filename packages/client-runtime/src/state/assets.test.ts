import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createAssetEnvironmentAtoms,
  InvalidAssetCollectionKeyError,
  parseAssetCollectionKey,
} from "./assets.ts";
import { executeAtomQuery } from "./runtime.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

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

  it.effect("limits reconnect asset URL fan-out across environments", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const release = Latch.makeUnsafe();
        const reachedLimit = Latch.makeUnsafe();
        let active = 0;
        let maximumActive = 0;
        let started = 0;
        const client = {
          [WS_METHODS.assetsCreateUrl]: (input: {
            readonly resource: { readonly _tag: "project-favicon"; readonly cwd: string };
          }) =>
            Effect.sync(() => {
              active += 1;
              started += 1;
              maximumActive = Math.max(maximumActive, active);
              if (active === 8) reachedLimit.openUnsafe();
            }).pipe(
              Effect.andThen(release.await),
              Effect.as({
                relativeUrl: `/api/assets/${encodeURIComponent(input.resource.cwd)}`,
                expiresAt: 1_000_000,
              }),
              Effect.ensuring(
                Effect.sync(() => {
                  active -= 1;
                }),
              ),
            ),
        } as unknown as WsRpcProtocolClient;
        const connectionState: SupervisorConnectionState = {
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online",
          phase: "connected",
          attempt: 1,
          generation: 1,
        };
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(connectionState),
          session: yield* SubscriptionRef.make(Option.some(session(client))),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
          _environmentId,
          effect,
        ) => Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
        const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
          _environmentId,
          stream,
        ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          run,
          followStream,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
        );
        const assets = createAssetEnvironmentAtoms(runtime);
        const secondEnvironmentId = EnvironmentId.make("environment-2");
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (current) =>
          Effect.sync(() => current.dispose()),
        );
        const queries = Array.from({ length: 24 }, (_, index) =>
          executeAtomQuery(
            registry,
            assets.createUrl({
              environmentId: index % 2 === 0 ? TARGET.environmentId : secondEnvironmentId,
              input: {
                resource: {
                  _tag: "project-favicon",
                  cwd: `/repo/${index}`,
                },
              },
            }),
            { reportDefect: false, reportFailure: false },
          ),
        );

        yield* reachedLimit.await.pipe(Effect.timeout("5 seconds"));
        expect(active).toBe(8);
        expect(started).toBe(8);
        expect(maximumActive).toBe(8);

        release.openUnsafe();
        const results = yield* Effect.promise(() => Promise.all(queries));
        expect(results.every((result) => result._tag === "Success")).toBe(true);
        expect(started).toBe(24);
        expect(maximumActive).toBe(8);
      }),
    ),
  );
});
