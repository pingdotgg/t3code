import {
  EnvironmentId,
  WS_METHODS,
  type SourceControlPublishRepositoryResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createSourceControlEnvironmentAtoms } from "./sourceControl.ts";
import { vcsRefsCacheStateAtom } from "./vcsRefInvalidation.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PUBLISH_RESULT: SourceControlPublishRepositoryResult = {
  repository: {
    provider: "github",
    nameWithOwner: "t3tools/t3code",
    url: "https://github.com/t3tools/t3code",
    sshUrl: "git@github.com:t3tools/t3code.git",
  },
  remoteName: "origin",
  remoteUrl: "git@github.com:t3tools/t3code.git",
  branch: "main",
  upstreamBranch: "origin/main",
  status: "pushed",
};

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

describe("source control environment atoms", () => {
  it.effect("invalidates cached refs after successful and failed publishing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connectionState: SupervisorConnectionState = {
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online",
          phase: "connected",
          attempt: 1,
          generation: 1,
        };
        let publishAttempts = 0;
        const client = {
          [WS_METHODS.sourceControlPublishRepository]: () => {
            publishAttempts += 1;
            return publishAttempts === 1
              ? Effect.succeed(PUBLISH_RESULT)
              : Effect.fail(
                  new EnvironmentRpcUnavailableError({
                    environmentId: TARGET.environmentId,
                    message: "push failed after adding the remote",
                  }),
                );
          },
        } as unknown as WsRpcProtocolClient;
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
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          run,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const removed = new Array<string>();
        const cache = Persistence.EnvironmentCacheStore.of({
          loadShell: () => Effect.succeed(Option.none()),
          saveShell: () => Effect.void,
          loadThread: () => Effect.succeed(Option.none()),
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          loadServerConfig: () => Effect.succeed(Option.none()),
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeed(Option.none()),
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: (environmentId, cwd) =>
            Effect.sync(() => {
              removed.push(`${environmentId}:${cwd}`);
            }),
          clearVcsRefs: (environmentId) =>
            Effect.sync(() => {
              removed.push(`${environmentId}:*`);
            }),
          clear: () => Effect.void,
        });
        const runtime = Atom.runtime(
          Layer.merge(
            Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
            Layer.succeed(Persistence.EnvironmentCacheStore, cache),
          ),
        );
        const atoms = createSourceControlEnvironmentAtoms(runtime);
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
          Effect.sync(() => registry.dispose()),
        );
        const state = vcsRefsCacheStateAtom({ environmentId: TARGET.environmentId });

        expect(registry.get(state).revision).toBe(0);
        const publishResult = yield* Effect.promise(() =>
          atoms.publishRepository.run(registry, {
            environmentId: TARGET.environmentId,
            input: {
              cwd: "/repo",
              provider: "github",
              repository: "t3tools/t3code",
              visibility: "private",
            },
          }),
        );

        expect(AsyncResult.isSuccess(publishResult)).toBe(true);
        expect(registry.get(state).revision).toBe(1);
        expect(removed).toEqual([`${TARGET.environmentId}:*`]);

        const failedPublish = yield* Effect.promise(() =>
          atoms.publishRepository.run(registry, {
            environmentId: TARGET.environmentId,
            input: {
              cwd: "/repo",
              provider: "github",
              repository: "t3tools/t3code",
              visibility: "private",
            },
          }),
        );

        expect(AsyncResult.isFailure(failedPublish)).toBe(true);
        expect(registry.get(state).revision).toBe(2);
        expect(removed).toEqual([`${TARGET.environmentId}:*`, `${TARGET.environmentId}:*`]);
      }),
    ),
  );
});
