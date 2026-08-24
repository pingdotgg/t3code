import {
  EnvironmentId,
  WS_METHODS,
  type ServerConfig,
  type SourceControlPublishRepositoryResult,
  SourceControlRepositoryError,
  type SourceControlSshPasswordPromptResolutionInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
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

function session(client: WsRpcProtocolClient, sourceControlSshPasswordPrompts = false): RpcSession {
  return {
    client,
    initialConfig: Effect.succeed({
      environment: {
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        capabilities: {
          repositoryIdentity: true,
          ...(sourceControlSshPasswordPrompts ? { sourceControlSshPasswordPrompts: true } : {}),
        },
      },
    } as ServerConfig),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const makeCommandHarness = Effect.fn("sourceControl.test.makeCommandHarness")(function* (
  client: WsRpcProtocolClient,
  sourceControlSshPasswordPrompts: boolean,
) {
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
    session: yield* SubscriptionRef.make(
      Option.some(session(client, sourceControlSshPasswordPrompts)),
    ),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
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
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      Layer.succeed(Persistence.EnvironmentCacheStore, cache),
    ),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return {
    atoms: createSourceControlEnvironmentAtoms(runtime),
    registry,
  };
});

describe("source control environment atoms", () => {
  it.effect("relays SSH password prompts while cloning", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const resolutionReceived = yield* Deferred.make<void>();
        const promptRequests: string[] = [];
        const cloneResult = {
          cwd: "/workspace/t3code",
          remoteUrl: "git@github.com:t3tools/t3code.git",
          repository: null,
        };
        const client = {
          [WS_METHODS.sourceControlCloneRepositoryWithPrompts]: () =>
            Stream.make({
              _tag: "ssh_password_prompt" as const,
              request: {
                requestId: "clone-prompt-1",
                destination: "git@github.com:t3tools/t3code.git",
                username: null,
                prompt: "Enter the SSH key passphrase or password.",
                attempt: 1,
                expiresAt: "2026-08-17T10:00:00.000Z",
                expiresInMs: 3 * 60 * 1_000,
              },
            }).pipe(
              Stream.concat(
                Stream.fromEffect(
                  Deferred.await(resolutionReceived).pipe(
                    Effect.as({ _tag: "complete" as const, result: cloneResult }),
                  ),
                ),
              ),
            ),
          [WS_METHODS.sourceControlResolveSshPasswordPrompt]: () =>
            Deferred.succeed(resolutionReceived, undefined).pipe(Effect.asVoid),
        } as unknown as WsRpcProtocolClient;
        const harness = yield* makeCommandHarness(client, true);

        const result = yield* Effect.promise(() =>
          harness.atoms.cloneRepository.run(harness.registry, {
            environmentId: TARGET.environmentId,
            input: {
              remoteUrl: cloneResult.remoteUrl,
              destinationPath: cloneResult.cwd,
            },
            onSshPasswordPrompt: async (request) => {
              promptRequests.push(request.requestId);
              return "secret";
            },
          }),
        );

        expect(AsyncResult.isSuccess(result)).toBe(true);
        expect(promptRequests).toEqual(["clone-prompt-1"]);
      }),
    ),
  );

  it.effect("relays SSH password prompts while publishing and returns the streamed result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const promptRequests = new Array<string>();
        const resolutions = new Array<{ requestId: string; password: string | null }>();
        const resolutionReceived = yield* Deferred.make<void>();
        let unaryCalls = 0;
        const client = {
          [WS_METHODS.sourceControlPublishRepository]: () => {
            unaryCalls += 1;
            return Effect.succeed(PUBLISH_RESULT);
          },
          [WS_METHODS.sourceControlPublishRepositoryWithPrompts]: () =>
            Stream.make({
              _tag: "ssh_password_prompt" as const,
              request: {
                requestId: "prompt-1",
                destination: "git@github.com:t3tools/t3code.git",
                username: null,
                prompt: "Enter the SSH key passphrase or password.",
                attempt: 1,
                expiresAt: "2026-08-17T10:00:00.000Z",
                expiresInMs: 3 * 60 * 1_000,
              },
            }).pipe(
              Stream.concat(
                Stream.fromEffect(
                  Deferred.await(resolutionReceived).pipe(
                    Effect.as({ _tag: "complete" as const, result: PUBLISH_RESULT }),
                  ),
                ),
              ),
            ),
          [WS_METHODS.sourceControlResolveSshPasswordPrompt]: (
            input: SourceControlSshPasswordPromptResolutionInput,
          ) =>
            Effect.sync(() => {
              resolutions.push(input);
            }).pipe(Effect.andThen(Deferred.succeed(resolutionReceived, undefined)), Effect.asVoid),
        } as unknown as WsRpcProtocolClient;
        const harness = yield* makeCommandHarness(client, true);

        const result = yield* Effect.promise(() =>
          harness.atoms.publishRepository.run(harness.registry, {
            environmentId: TARGET.environmentId,
            input: {
              cwd: "/repo",
              provider: "github",
              repository: "t3tools/t3code",
              visibility: "private",
              protocol: "ssh",
            },
            onSshPasswordPrompt: async (request) => {
              promptRequests.push(request.requestId);
              return "correct horse battery staple";
            },
          }),
        );

        expect(AsyncResult.isSuccess(result)).toBe(true);
        if (AsyncResult.isSuccess(result)) {
          expect(result.value).toEqual(PUBLISH_RESULT);
        }
        expect(unaryCalls).toBe(0);
        expect(promptRequests).toEqual(["prompt-1"]);
        expect(resolutions).toEqual([
          { requestId: "prompt-1", password: "correct horse battery staple" },
        ]);
      }),
    ),
  );

  it.effect("fails publishing when the SSH prompt response cannot reach the server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const expectedError = new EnvironmentRpcUnavailableError({
          environmentId: TARGET.environmentId,
          message: "SSH prompt submission failed",
        });
        const client = {
          [WS_METHODS.sourceControlPublishRepositoryWithPrompts]: () =>
            Stream.make({
              _tag: "ssh_password_prompt" as const,
              request: {
                requestId: "prompt-1",
                destination: "github.com",
                username: null,
                prompt: "Enter the SSH key passphrase or password.",
                attempt: 1,
                expiresAt: "2026-08-17T10:00:00.000Z",
                expiresInMs: 3 * 60 * 1_000,
              },
            }),
          [WS_METHODS.sourceControlResolveSshPasswordPrompt]: () => Effect.fail(expectedError),
        } as unknown as WsRpcProtocolClient;
        const harness = yield* makeCommandHarness(client, true);

        const result = yield* Effect.promise(() =>
          harness.atoms.publishRepository.run(harness.registry, {
            environmentId: TARGET.environmentId,
            input: {
              cwd: "/repo",
              provider: "github",
              repository: "t3tools/t3code",
              visibility: "private",
              protocol: "ssh",
            },
            onSshPasswordPrompt: async () => "secret",
          }),
        );

        expect(AsyncResult.isFailure(result)).toBe(true);
      }),
    ),
  );

  it.effect("falls back to unary publishing when the server lacks SSH prompt support", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let unaryCalls = 0;
        let promptCalls = 0;
        const client = {
          [WS_METHODS.sourceControlPublishRepository]: () => {
            unaryCalls += 1;
            return Effect.succeed(PUBLISH_RESULT);
          },
        } as unknown as WsRpcProtocolClient;
        const harness = yield* makeCommandHarness(client, false);

        const result = yield* Effect.promise(() =>
          harness.atoms.publishRepository.run(harness.registry, {
            environmentId: TARGET.environmentId,
            input: {
              cwd: "/repo",
              provider: "github",
              repository: "t3tools/t3code",
              visibility: "private",
              protocol: "ssh",
            },
            onSshPasswordPrompt: async () => {
              promptCalls += 1;
              return null;
            },
          }),
        );

        expect(AsyncResult.isSuccess(result)).toBe(true);
        expect(unaryCalls).toBe(1);
        expect(promptCalls).toBe(0);
      }),
    ),
  );

  it.effect("settles a failed publish while its SSH prompt is still open", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let promptCalls = 0;
        const client = {
          [WS_METHODS.sourceControlPublishRepositoryWithPrompts]: () =>
            Stream.make({
              _tag: "ssh_password_prompt" as const,
              request: {
                requestId: "prompt-1",
                destination: "github.com",
                username: null,
                prompt: "Enter the SSH key passphrase or password.",
                attempt: 1,
                expiresAt: "2026-08-17T10:00:00.000Z",
                expiresInMs: 3 * 60 * 1_000,
              },
            }).pipe(
              Stream.concat(
                Stream.fail(
                  new SourceControlRepositoryError({
                    provider: "github",
                    operation: "publishRepository",
                    detail: "The source control operation could not be completed.",
                  }),
                ),
              ),
            ),
        } as unknown as WsRpcProtocolClient;
        const harness = yield* makeCommandHarness(client, true);

        const result = yield* Effect.promise(() =>
          harness.atoms.publishRepository.run(harness.registry, {
            environmentId: TARGET.environmentId,
            input: {
              cwd: "/repo",
              provider: "github",
              repository: "t3tools/t3code",
              visibility: "private",
              protocol: "ssh",
            },
            onSshPasswordPrompt: () => {
              promptCalls += 1;
              return new Promise<string | null>(() => undefined);
            },
          }),
        );

        expect(AsyncResult.isFailure(result)).toBe(true);
        expect(promptCalls).toBe(1);
      }),
    ),
  );

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
