import { expect, it } from "@effect/vitest";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import {
  EnvironmentId,
  IssueOperationError,
  ProjectId,
  WS_METHODS,
  type IssueCandidates,
  type IssueScopeRef,
  IssueTrackerKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { appAtomRegistry } from "./atom-registry";
import { issueEnvironment, refreshIssueFilterCandidates } from "./issues";

const fixture = vi.hoisted(() => ({
  environment: undefined as EnvironmentRegistry.EnvironmentRegistry["Service"] | undefined,
}));

vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    connectionAtomRuntime: Atom.runtime(
      Layer.suspend(() =>
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, fixture.environment!),
      ),
    ),
  };
});

it.effect("retrying a partially loaded issue filter only requests the failed repository", () =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("issues-environment");
    const scope = (name: string) => ({
      environmentId,
      input: {
        projectId: ProjectId.make(name),
        tracker: IssueTrackerKind.make("github"),
        host: "github.com",
        scope: `acme/${name}`,
      },
    });
    const healthy = scope("healthy");
    const flaky = scope("flaky");
    const requests: string[] = [];
    const client = {
      [WS_METHODS.issuesCandidates]: (input: IssueScopeRef) =>
        Effect.suspend(() => {
          const firstRequest = !requests.includes(input.scope);
          requests.push(input.scope);
          if (input.scope === flaky.input.scope && firstRequest) {
            return Effect.fail(
              new IssueOperationError({
                operation: "candidates",
                detail: "Repository unavailable.",
              }),
            );
          }
          return Effect.succeed({
            labels: [{ name: input.scope, color: null, description: null }],
            assignees: [],
            truncated: false,
          } satisfies IssueCandidates);
        }),
    };
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: new PrimaryConnectionTarget({
        environmentId,
        label: "Issues environment",
        httpBaseUrl: "https://issues.test",
        wsBaseUrl: "wss://issues.test",
      }),
      state: yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected" as const,
        desired: true,
        network: "online" as const,
        attempt: 1,
        generation: 1,
      }),
      session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });

    fixture.environment = {
      run: (_id, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      followStream: (_id, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    } as EnvironmentRegistry.EnvironmentRegistry["Service"];

    const healthyCandidates = issueEnvironment.candidates(healthy);
    const flakyCandidates = issueEnvironment.candidates(flaky);
    const unmountHealthy = appAtomRegistry.mount(healthyCandidates);
    const unmountFlaky = appAtomRegistry.mount(flakyCandidates);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unmountHealthy();
        unmountFlaky();
        appAtomRegistry.dispose();
        fixture.environment = undefined;
      }),
    );
    const read = (atom: typeof healthyCandidates) =>
      AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true });
    yield* read(healthyCandidates);
    expect((yield* read(flakyCandidates).pipe(Effect.result))._tag).toBe("Failure");

    refreshIssueFilterCandidates([healthy, flaky]);

    const recovered = yield* read(flakyCandidates);
    expect(recovered.labels.map((label) => label.name)).toEqual(["acme/flaky"]);
    yield* read(healthyCandidates);
    expect(requests, "candidate requests across the first load and one retry").toHaveLength(3);
  }),
);
