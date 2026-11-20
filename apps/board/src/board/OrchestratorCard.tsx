import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { isRunLive } from "../chat/timeline";
import { STAGE_LABEL, TICKET_STAGES } from "../domain/ticket";
import type { OrchestratorStats } from "../orchestrator/brief";
import { useEnvironmentThread } from "../state/threads";
import type { ValidBoard } from "../store/boardFiles";
import { ORCHESTRATOR_BOX } from "./layout";

/** A board's orchestrator on the canvas: its tickets by stage, what waits on the user, and its builders against the cap. */
export function OrchestratorCard({
  project,
  listed,
  stats,
}: {
  project: EnvironmentProject;
  listed: ValidBoard;
  stats: OrchestratorStats;
}) {
  const { board } = listed;
  // The panel holds the same thread open, so this adds no second subscription.
  const projection = Option.getOrNull(
    useEnvironmentThread(
      project.environmentId,
      board.orchestratorThreadId === null ? null : ThreadId.make(board.orchestratorThreadId),
    ).data,
  );
  const status =
    board.orchestratorThreadId === null
      ? "Not started"
      : projection !== null && isRunLive(projection)
        ? "Working"
        : "Idle";

  return (
    <section
      aria-label="Orchestrator card"
      data-testid="orchestrator-card"
      className="absolute rounded-xl border border-line bg-panel p-3 shadow-panel"
      style={{ left: ORCHESTRATOR_BOX.x, top: ORCHESTRATOR_BOX.y, width: ORCHESTRATOR_BOX.width }}
    >
      <header className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate font-semibold">{board.name}</h3>
        <span data-testid="card-status" className="text-[11px] text-muted">
          {status}
        </span>
      </header>
      <p className="mt-0.5 text-[11px] text-faint">Orchestrator</p>
      <dl className="mt-2.5 grid grid-cols-4 gap-x-2 gap-y-2">
        {TICKET_STAGES.map((stage) => (
          <div key={stage} className="min-w-0">
            <dt className="text-[10px] leading-tight text-faint">{STAGE_LABEL[stage]}</dt>
            <dd className={stats.stages[stage] === 0 ? "text-faint" : "text-fg"}>
              {stats.stages[stage]}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex items-center justify-between border-t border-line pt-2">
        <span className="text-muted">
          For you{" "}
          <span data-testid="foryou-open" className={stats.forYouOpen > 0 ? "text-fg" : ""}>
            {stats.forYouOpen}
          </span>
        </span>
        <span className="text-muted">
          Builders{" "}
          <span data-testid="builders" className="text-fg">
            {stats.buildersInUse} of {stats.builderCap}
          </span>
        </span>
      </div>
      <p className="mt-2 line-clamp-2 text-[11px] text-muted" data-testid="latest-decision">
        {stats.latestDecision === null
          ? "No decisions yet"
          : `${stats.latestDecision.time}  ${stats.latestDecision.decision}`}
      </p>
      {stats.problems.map((problem) => (
        <p key={problem} role="alert" className="mt-1 text-[11px] break-words text-red-400">
          {problem}
        </p>
      ))}
    </section>
  );
}
