import * as Cause from "effect/Cause";
import type {
  GitWorkflowProgress,
  GitWorkflowProgressUpdate,
  GitWorkflowStep,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export type ProgressReporter = (update: GitWorkflowProgressUpdate) => Effect.Effect<void>;

export function reportSteps(
  report: ProgressReporter | undefined,
  initial: readonly GitWorkflowStep[],
) {
  let steps = initial;
  return Effect.fn("WorkflowProgress.steps")(function* (
    label: string,
    update: (steps: readonly GitWorkflowStep[]) => readonly GitWorkflowStep[] = (steps) => steps,
  ) {
    steps = update(steps);
    if (report) yield* report({ label, steps });
  });
}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const entries = new Map<
    string,
    {
      ref: SubscriptionRef.SubscriptionRef<GitWorkflowProgress | null>;
      readers: number;
      active: boolean;
    }
  >();
  const entry = Effect.fn("WorkflowProgress.entry")(function* (cwd: string) {
    const key = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
    const previous = entries.get(key);
    if (previous) return previous;
    const created = {
      ref: yield* SubscriptionRef.make<GitWorkflowProgress | null>(null),
      readers: 0,
      active: false,
    };
    const current = entries.get(key) ?? created;
    entries.set(key, current);
    for (const [name, value] of entries) {
      if (entries.size <= 256) break;
      if (name !== key && value.readers === 0 && !value.active) entries.delete(name);
    }
    return current;
  });
  const run = Effect.fn("WorkflowProgress.run")(function* <A, E, R>(
    cwd: string,
    kind: GitWorkflowProgress["kind"],
    label: string,
    action: (report: ProgressReporter) => Effect.Effect<A, E, R>,
  ) {
    const owner = yield* entry(cwd);
    owner.active = true;
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const startedAtMs = yield* Clock.currentTimeMillis;
        yield* SubscriptionRef.set(owner.ref, {
          kind,
          state: "running",
          startedAtMs,
          label,
          steps: [],
        });
        const report: ProgressReporter = (update) => {
          const snapshot: GitWorkflowProgress = { ...update, kind, state: "running", startedAtMs };
          return SubscriptionRef.set(owner.ref, snapshot);
        };
        const finish = (state: GitWorkflowProgress["state"]) =>
          SubscriptionRef.update(owner.ref, (current): GitWorkflowProgress | null =>
            current
              ? {
                  ...current,
                  state,
                  label:
                    state === "completed"
                      ? kind === "stack"
                        ? "Stack updated"
                        : "Logical commits created"
                      : state === "cancelled"
                        ? "Workflow cancelled"
                        : "Workflow stopped",
                  steps: current.steps.map((step): GitWorkflowStep =>
                    step.state === "running"
                      ? {
                          ...step,
                          state:
                            state === "completed"
                              ? "completed"
                              : state === "cancelled"
                                ? "skipped"
                                : "failed",
                        }
                      : step,
                  ),
                }
              : null,
          );
        return yield* restore(action(report)).pipe(
          Effect.tap(() => finish("completed")),
          Effect.onError((cause) =>
            finish(Cause.hasInterruptsOnly(cause) ? "cancelled" : "failed"),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              owner.active = false;
            }),
          ),
        );
      }),
    );
  });
  return {
    run,
    clear: Effect.fn("WorkflowProgress.clear")(function* (cwd: string) {
      yield* SubscriptionRef.set((yield* entry(cwd)).ref, null);
    }),
    subscribe: (cwd: string) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const owner = yield* entry(cwd);
          return SubscriptionRef.changes(owner.ref).pipe(
            Stream.ensuring(
              Effect.sync(() => {
                owner.readers--;
              }),
            ),
            Stream.onStart(
              Effect.sync(() => {
                owner.readers++;
              }),
            ),
          );
        }),
      ),
  };
});
