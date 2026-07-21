import type { EnvironmentId, OrchestrationShellSnapshot, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export type ShellThreadMembership = "unknown" | "present" | "absent";
export type ShellMembershipRevision = number;

interface EnvironmentMembershipState {
  readonly revision: ShellMembershipRevision;
  readonly snapshot: OrchestrationShellSnapshot | undefined;
}

export class EnvironmentShellMembership extends Context.Service<
  EnvironmentShellMembership,
  {
    readonly getThreadMembership: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<ShellThreadMembership>;
    readonly setAuthoritative: (
      environmentId: EnvironmentId,
      snapshot: OrchestrationShellSnapshot,
      revision: ShellMembershipRevision,
    ) => Effect.Effect<void>;
    readonly setUnknown: (environmentId: EnvironmentId) => Effect.Effect<ShellMembershipRevision>;
  }
>()("@t3tools/client-runtime/state/shellMembership/EnvironmentShellMembership") {}

export const environmentShellMembershipLayer = Layer.effect(
  EnvironmentShellMembership,
  Effect.gen(function* () {
    const states = yield* Ref.make<ReadonlyMap<EnvironmentId, EnvironmentMembershipState>>(
      new Map(),
    );

    return EnvironmentShellMembership.of({
      getThreadMembership: (environmentId, threadId) =>
        Ref.get(states).pipe(
          Effect.map((current) => {
            const snapshot = current.get(environmentId)?.snapshot;
            if (snapshot === undefined) {
              return "unknown";
            }
            return snapshot.threads.some((thread) => thread.id === threadId) ? "present" : "absent";
          }),
        ),
      setAuthoritative: (environmentId, snapshot, revision) =>
        Ref.update(states, (current) => {
          const state = current.get(environmentId);
          if (state === undefined || state.revision !== revision) {
            return current;
          }
          return new Map(current).set(environmentId, { revision, snapshot });
        }),
      setUnknown: (environmentId) =>
        Ref.modify(states, (current) => {
          const revision = (current.get(environmentId)?.revision ?? 0) + 1;
          return [revision, new Map(current).set(environmentId, { revision, snapshot: undefined })];
        }),
    });
  }),
);
