/** @jsxImportSource react */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { render } from "ink";
import type { Plan } from "../../Plan.ts";
import { type PlanStatusSession, Cli } from "../Cli.ts";
import type { ApplyEvent } from "../Event.ts";
import { ApprovePlan } from "./components/ApprovePlan.tsx";
import { Plan as PlanComponent } from "./components/Plan.tsx";
import { PlanProgress } from "./components/PlanProgress.tsx";

export const inkCLI = () =>
  Layer.succeed(
    Cli,
    Cli.of({
      approvePlan,
      displayPlan,
      startApplySession,
    }),
  );

const approvePlan = Effect.fn(function* <P extends Plan>(plan: P) {
  let approved = false;
  const { waitUntilExit } = render(
    <ApprovePlan plan={plan} approve={(a) => (approved = a)} />,
  );
  yield* Effect.promise(waitUntilExit);
  return approved;
});

const displayPlan = <P extends Plan>(plan: P): Effect.Effect<void> =>
  Effect.sync(() => {
    const { unmount } = render(<PlanComponent plan={plan} />);
    unmount();
  });

const startApplySession = Effect.fn(function* <P extends Plan>(plan: P) {
  const listeners = new Set<(event: ApplyEvent) => void>();
  const { unmount } = render(
    <PlanProgress
      plan={plan}
      source={{
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }}
    />,
  );
  return {
    done: Effect.fn(function* () {
      yield* Effect.sleep(10); // give the react event loop time to re-render
      yield* Effect.sync(() => unmount());
    }),
    emit: (event) =>
      Effect.sync(() => {
        for (const listener of listeners) listener(event);
      }),
  } satisfies PlanStatusSession;
});
