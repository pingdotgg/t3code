import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { TriangleAlert } from "lucide-react";
import { useContext, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { ArtifactsProvider } from "../artifacts/ArtifactsContext";
import { useBoardArtifacts } from "../artifacts/useBoardArtifacts";
import { chatSlotAtom, checksSlotAtom } from "../browser/panel";
import { OrchestratorPanel } from "../chat/OrchestratorPanel";
import { ChecksPanel } from "../checks/ChecksPanel";
import { MainTabs } from "../files/MainTabs";
import { mergeTicketKey } from "../domain/readiness";
import { frameOrderAtom, peekAtom } from "../state/boardUi";
import { useThreadFamily } from "../state/family";
import { PrProvider } from "../state/prStatus";
import { focusedCardAtom, useBoardForYou } from "../state/forYou";
import { addDocs } from "../state/attachmentUploads";
import { useBoardView } from "../state/boardView";
import type { ValidBoard } from "../store/boardFiles";
import { ForYouLane } from "./ForYouLane";
import { Lanes } from "./Lanes";
import { forYouHeight, layoutBoard } from "./layout";
import { OrchestratorCard } from "./OrchestratorCard";
import { PeekDrawer } from "./PeekDrawer";
import { Viewport } from "./Viewport";

const NO_ORDER = {};

/** A board's orchestrator card and lanes on the canvas, the peek drawer over it, and the orchestrator's chat, which draws in the side panel's first tab. Open files are tabs over the canvas. */
export function BoardScreen({
  project,
  listed,
}: {
  project: EnvironmentProject;
  listed: ValidBoard;
}) {
  const registry = useContext(RegistryContext);
  const [dropError, setDropError] = useState<string | null>(null);
  const { board } = listed;
  const { model, issue, stats } = useBoardView(project, listed);
  const order = useAtomValue(frameOrderAtom)[board.id] ?? NO_ORDER;
  const forYou = useBoardForYou(project, listed);
  const artifacts = useBoardArtifacts(project, listed, model);
  const layout = useMemo(
    () => layoutBoard(model, order, forYouHeight(forYou.views), artifacts.cards),
    [model, order, forYou.views, artifacts.cards],
  );
  const family = useThreadFamily(project.environmentId, board.orchestratorThreadId);
  const tickets = useMemo(() => Object.values(model.lanes).flat(), [model]);
  const prContext = useMemo(() => {
    const keys = tickets.map((view) => view.ticket.key);
    const mergeOrderNotes = new Map<string, string>();
    // Cards run oldest first, so a later approval for a ticket replaces an earlier one.
    for (const { card } of forYou.views) {
      if (card.origin !== "file" || card.item.kind !== "merge_approval") continue;
      const key = mergeTicketKey(card.item, keys);
      const note = card.item.conditions.parent_ready.note;
      if (key !== null && note != null) mergeOrderNotes.set(key, note);
    }
    return {
      project,
      orchestratorThreadId: board.orchestratorThreadId ?? "",
      family,
      tickets,
      mergeOrderNotes,
    };
  }, [project, board.orchestratorThreadId, family, tickets, forYou.views]);
  const chatSlot = useAtomValue(chatSlotAtom);
  const checksSlot = useAtomValue(checksSlotAtom);
  const peek = useAtomValue(peekAtom);
  const focused = useAtomValue(focusedCardAtom);
  const focusedId =
    focused?.boardId === board.id && forYou.views.some((view) => view.card.id === focused.cardId)
      ? focused.cardId
      : null;
  return (
    <ArtifactsProvider value={artifacts.value}>
      <PrProvider value={prContext}>
        <div className="flex h-full min-h-0">
          <MainTabs files={artifacts.value.files}>
            <Viewport
              content={layout.content}
              onDropFiles={(files) =>
                void addDocs(
                  registry,
                  project.environmentId,
                  board.orchestratorThreadId,
                  files,
                ).then(setDropError)
              }
            >
              <OrchestratorCard
                project={project}
                listed={listed}
                stats={{ ...stats, forYouOpen: forYou.open }}
              />
              <Lanes
                layout={layout}
                model={model}
                boardId={board.id}
                forYouOpen={forYou.open}
                forYouLane={
                  <ForYouLane
                    project={project}
                    listed={listed}
                    forYou={forYou}
                    focusedId={focusedId}
                  />
                }
                peek={peek}
                onPeek={(next) => registry.set(peekAtom, next)}
              />
            </Viewport>
            <div className="absolute bottom-3.5 left-3.5 z-10 flex max-w-[60%] flex-col gap-2">
              {dropError !== null && (
                <p
                  role="alert"
                  data-testid="drop-error"
                  className="rounded-lg border border-red-400/40 bg-panel px-3 py-2 break-words text-red-300 shadow-panel"
                >
                  {dropError}
                </p>
              )}
              {issue !== null && (
                <div
                  role="alert"
                  data-testid="tickets-banner"
                  className="flex items-start gap-2 rounded-lg border border-red-400/40 bg-panel px-3 py-2 text-red-300 shadow-panel"
                >
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <div className="min-w-0">
                    <p className="font-semibold">
                      tickets.json has a bad {issue.fields.length === 1 ? "field" : "fields"}
                      {issue.fields.length > 0 ? `: ${issue.fields.join(", ")}` : ""}. Showing the
                      last valid layout.
                    </p>
                    <p className="text-[11px] break-words text-red-300/80">{issue.message}</p>
                  </div>
                </div>
              )}
              {forYou.problems.length > 0 && (
                <div
                  role="alert"
                  data-testid="foryou-banner"
                  className="flex items-start gap-2 rounded-lg border border-red-400/40 bg-panel px-3 py-2 text-red-300 shadow-panel"
                >
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <div className="min-w-0">
                    <p className="font-semibold">
                      foryou.jsonl has a bad {forYou.problems.length === 1 ? "line" : "lines"}:{" "}
                      {forYou.problems.map((problem) => problem.line).join(", ")}. The other cards
                      still show.
                    </p>
                    {forYou.problems.map((problem) => (
                      <p key={problem.line} className="text-[11px] break-words text-red-300/80">
                        Line {problem.line}: {problem.message}
                      </p>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <PeekDrawer
              environmentId={project.environmentId}
              model={model}
              peek={peek}
              onClose={() => registry.set(peekAtom, null)}
            />
          </MainTabs>
          {chatSlot !== null &&
            createPortal(<OrchestratorPanel project={project} listed={listed} />, chatSlot)}
          {checksSlot !== null && createPortal(<ChecksPanel />, checksSlot)}
        </div>
      </PrProvider>
    </ArtifactsProvider>
  );
}
