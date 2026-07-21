import type { EnvironmentId, OrchestrationShellSnapshot, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export type ShellThreadMembership = "unknown" | "present" | "absent";

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
    ) => Effect.Effect<void>;
    readonly setUnknown: (environmentId: EnvironmentId) => Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/state/shellMembership/EnvironmentShellMembership") {}

export const environmentShellMembershipLayer = Layer.effect(
  EnvironmentShellMembership,
  Effect.gen(function* () {
    const snapshots = yield* Ref.make<ReadonlyMap<EnvironmentId, OrchestrationShellSnapshot>>(
      new Map(),
    );

    return EnvironmentShellMembership.of({
      getThreadMembership: (environmentId, threadId) =>
        Ref.get(snapshots).pipe(
          Effect.map((current) => {
            const snapshot = current.get(environmentId);
            if (snapshot === undefined) {
              return "unknown";
            }
            return snapshot.threads.some((thread) => thread.id === threadId) ? "present" : "absent";
          }),
        ),
      setAuthoritative: (environmentId, snapshot) =>
        Ref.update(snapshots, (current) => new Map(current).set(environmentId, snapshot)),
      setUnknown: (environmentId) =>
        Ref.update(snapshots, (current) => {
          if (!current.has(environmentId)) {
            return current;
          }
          const next = new Map(current);
          next.delete(environmentId);
          return next;
        }),
    });
  }),
);
