import type { OrchestrationThreadGoal } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { ComposerGoalBadge } from "../components/chat/ComposerGoalBadge";

const MOCK_OBJECTIVE = "Reduce p95 latency below 120ms on the checkout API";
const MOCK_TIMESTAMPS = {
  createdAt: "2026-08-17T08:00:00.000Z",
  updatedAt: "2026-08-17T08:00:00.000Z",
};

const PREVIEW_STATES: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly goal: OrchestrationThreadGoal;
  readonly isWorking?: boolean;
}> = [
  {
    id: "goal-active",
    label: "Active",
    goal: { objective: MOCK_OBJECTIVE, status: "active", ...MOCK_TIMESTAMPS },
  },
  {
    id: "goal-running",
    label: "Running",
    goal: { objective: MOCK_OBJECTIVE, status: "active", ...MOCK_TIMESTAMPS },
    isWorking: true,
  },
  {
    id: "goal-paused",
    label: "Paused",
    goal: { objective: MOCK_OBJECTIVE, status: "paused", ...MOCK_TIMESTAMPS },
  },
  {
    id: "goal-blocked",
    label: "Blocked",
    goal: { objective: MOCK_OBJECTIVE, status: "blocked", ...MOCK_TIMESTAMPS },
  },
  {
    id: "goal-usage-limited",
    label: "Usage-limited",
    goal: { objective: MOCK_OBJECTIVE, status: "usageLimited", ...MOCK_TIMESTAMPS },
  },
  {
    id: "goal-complete",
    label: "Complete",
    goal: { objective: MOCK_OBJECTIVE, status: "complete", ...MOCK_TIMESTAMPS },
  },
];

export const Route = createFileRoute("/dev/goal-chips")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: DevGoalChipsPage,
});

function DevGoalChipsPage() {
  return (
    <div className="min-h-screen bg-background px-6 py-10">
      <div className="mx-auto flex max-w-3xl flex-col gap-10">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">Goal composer states</h1>
          <p className="text-sm text-muted-foreground">
            Dev-only preview for PR screenshots. Not shipped in production builds.
          </p>
        </header>
        {PREVIEW_STATES.map((state) => (
          <section key={state.id} data-goal-screenshot={state.id} className="space-y-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {state.label}
            </h2>
            <div className="chat-composer-glass-shell relative mx-auto w-full max-w-3xl">
              <div className="chat-composer-glass-host relative z-10 w-full rounded-[22px]">
                <div className="relative px-3 pb-2 pt-3.5 sm:px-4">
                  <ComposerGoalBadge
                    goal={state.goal}
                    isWorking={state.isWorking === true}
                    onAction={() => undefined}
                    onEdit={() => undefined}
                  />
                  <div
                    className="mt-8 min-h-[72px] rounded-[16px] border border-border/50 bg-muted/20 px-3 py-3 text-sm text-placeholder"
                    aria-hidden="true"
                  >
                    Ask anything…
                  </div>
                </div>
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
