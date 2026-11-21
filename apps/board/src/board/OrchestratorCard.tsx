import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { ListChecks, Plus } from "lucide-react";
import { useContext, useState } from "react";
import { createPortal } from "react-dom";

import { BOARD_KEY, useArtifacts } from "../artifacts/ArtifactsContext";
import { isRunLive } from "../chat/timeline";
import { pickTemplate, SYSTEM_TEMPLATE } from "../domain/reviewTemplate";
import { STAGE_LABEL, TICKET_STAGES } from "../domain/ticket";
import { AddFromIssue } from "../issues/AddFromIssue";
import type { OrchestratorStats } from "../orchestrator/brief";
import { baseInstanceId } from "../orchestrator/orchestratorInstance";
import { reviewTemplatesAtom, setBoardReviewTemplate, usageNoticeAtom } from "../state/reviews";
import { useEnvironmentThread } from "../state/threads";
import type { ValidBoard } from "../store/boardFiles";
import { PopMenu } from "../ui/PopMenu";
import { ArtifactCards } from "./ArtifactCards";
import { ArtifactCount } from "./ArtifactCount";
import { ORCHESTRATOR_BOX } from "./layout";

/** Cards stack in columns this tall, which is as many as fit beside the card. */
const ARTIFACT_ROWS = 5;

/** Mounts the board's usage watch, which messages the orchestrator when a usage window passes a level. */
function UsageWatch({ instanceId, threadId }: { instanceId: string; threadId: string }) {
  useAtomValue(usageNoticeAtom(`${baseInstanceId(instanceId)}/${threadId}`));
  return null;
}

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
  const { groups, expanded } = useArtifacts();
  const [adding, setAdding] = useState(false);
  const registry = useContext(RegistryContext);
  const custom = useAtomValue(reviewTemplatesAtom);
  const [pickError, setPickError] = useState<string | null>(null);
  const picked = pickTemplate(board.reviewTemplate, custom);
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
        {board.orchestratorThreadId !== null && (
          <button
            type="button"
            data-testid="add-from-tracker"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setAdding(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-line px-1.5 text-[11px] leading-5 text-muted hover:bg-hover hover:text-fg"
          >
            <Plus className="size-3" aria-hidden />
            Add from tracker
          </button>
        )}
        <div onPointerDown={(event) => event.stopPropagation()}>
          <PopMenu
            label="Review template"
            align="start"
            triggerClass="inline-flex shrink-0 items-center gap-1 rounded border border-line px-1.5 text-[11px] leading-5 text-muted hover:bg-hover hover:text-fg"
            trigger={
              <>
                <ListChecks className="size-3" aria-hidden />
                Review
              </>
            }
            items={[SYSTEM_TEMPLATE, ...custom].map((template) => ({
              label: template.name,
              hint: template.name === picked.name ? "Current" : undefined,
              onSelect: () => {
                setPickError(null);
                void setBoardReviewTemplate(
                  registry,
                  project,
                  listed,
                  template === SYSTEM_TEMPLATE ? undefined : template.name,
                ).then(setPickError);
              },
            }))}
          />
        </div>
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
        <span className="inline-flex items-center gap-1 text-muted">
          Artifacts <ArtifactCount id={BOARD_KEY} count={groups.board.length} />
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
      {pickError !== null && (
        <p role="alert" className="mt-1 text-[11px] break-words text-red-400">
          {pickError}
        </p>
      )}
      {stats.problems.map((problem) => (
        <p key={problem} role="alert" className="mt-1 text-[11px] break-words text-red-400">
          {problem}
        </p>
      ))}
      {expanded.has(BOARD_KEY) && groups.board.length > 0 && (
        <div className="absolute top-0" style={{ left: "calc(100% + 16px)" }}>
          <ArtifactCards artifacts={groups.board} rows={ARTIFACT_ROWS} />
        </div>
      )}
      {board.orchestratorThreadId !== null && projection !== null && (
        <UsageWatch
          instanceId={projection.thread.modelSelection.instanceId}
          threadId={board.orchestratorThreadId}
        />
      )}
      {adding &&
        board.orchestratorThreadId !== null &&
        createPortal(
          <AddFromIssue
            project={project}
            orchestratorThreadId={board.orchestratorThreadId}
            onDone={() => setAdding(false)}
          />,
          document.body,
        )}
    </section>
  );
}
