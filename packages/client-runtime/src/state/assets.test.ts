import { describe, expect, it } from "@effect/vitest";
import {
  type AssetCreateUrlResult,
  type AssetResource,
  AssetWorkspaceAssetNotFoundError,
  EnvironmentId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { resolveMediaSource } from "../mediaSource.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createAssetEnvironmentAtoms, createProjectFaviconUrlAtomFamily } from "./assets.ts";

describe("project favicon URL cache", () => {
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
});

describe("createAssetEnvironmentAtoms", () => {
  it.effect("keeps a relative markdown image on the remote host that owns the thread", () =>
    Effect.gen(function* () {
      const remoteId = EnvironmentId.make("remote");
      const localId = EnvironmentId.make("local");
      const workspaceRoot = "/tmp/t3-17392/repo";
      const threadId = ThreadId.make("remote-thread");
      const markdownImageResource = (authored: string, documentDir = workspaceRoot) => {
        const media = resolveMediaSource(authored, { threadId, workspaceRoot: documentDir });
        expect(media?.access).toBe("environment");
        return (media as Extract<typeof media, { access: "environment" }>).resource;
      };
      const calls: EnvironmentId[] = [];
      const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
      for (const environmentId of [remoteId, localId]) {
        const client = {
          [WS_METHODS.assetsCreateUrl]: ({ resource }: { readonly resource: AssetResource }) => {
            calls.push(environmentId);
            return environmentId === remoteId
              ? Effect.fail(new AssetWorkspaceAssetNotFoundError({ resource }))
              : Effect.succeed({ relativeUrl: "/api/assets/local/report.png", expiresAt: 1 });
          },
        } as unknown as WsRpcProtocolClient;
        supervisors.set(
          environmentId,
          EnvironmentSupervisor.of({
            target: new PrimaryConnectionTarget({
              environmentId,
              label: environmentId,
              httpBaseUrl: `https://${environmentId}.test`,
              wsBaseUrl: `wss://${environmentId}.test`,
            }),
            state: yield* SubscriptionRef.make<SupervisorConnectionState>({
              ...AVAILABLE_CONNECTION_STATE,
              phase: "connected",
            }),
            session: yield* SubscriptionRef.make(Option.some({ client } as RpcSession)),
            prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          }),
        );
      }
      const environments = EnvironmentRegistry.of({
        run: (id, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor, supervisors.get(id)!),
        followStream: (id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisors.get(id)!),
      } as EnvironmentRegistry["Service"]);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const assets = createAssetEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry, environments)),
        Atom.make({ environmentId: localId, httpBaseUrl: "https://local.test" }),
      );
      const resolve = (authored: string, documentDir?: string) =>
        AtomRegistry.getResult(
          registry,
          assets.createUrl({
            environmentId: remoteId,
            input: { resource: markdownImageResource(authored, documentDir) },
          }),
          { suspendOnWaiting: true },
        );

      // An explicit host path may still name a file on this desktop.
      for (const authored of [
        `${workspaceRoot}/docs/report.png`,
        "/tmp/t3-17392/docs/report.png",
        "D:\\docs\\report.png",
      ]) {
        calls.length = 0;
        expect((yield* resolve(authored)).relativeUrl).toBe(
          "https://local.test/api/assets/local/report.png",
        );
        expect(calls).toEqual([remoteId, localId]);
      }

      // The same files authored relative to their document, inside the workspace, outside
      // it, or on another drive, stay on the host and miss the cached local results.
      for (const [authored, documentDir] of [
        ["docs/report.png", workspaceRoot],
        ["report.png", "/tmp/t3-17392/docs"],
        ["report.png", "D:\\docs"],
      ] as const) {
        calls.length = 0;
        expect(yield* Effect.result(resolve(authored, documentDir))).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "AssetWorkspaceAssetNotFoundError" },
        });
        expect(calls).toEqual([remoteId]);
      }
    }).pipe(Effect.scoped),
  );
});
