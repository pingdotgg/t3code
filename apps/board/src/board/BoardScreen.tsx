import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { TriangleAlert } from "lucide-react";
import { useContext, useMemo } from "react";

import { ArtifactsProvider } from "../artifacts/ArtifactsContext";
import { ArtifactViewer } from "../artifacts/ArtifactViewer";
import { useBoardArtifacts } from "../artifacts/useBoardArtifacts";
import { OrchestratorPanel } from "../chat/OrchestratorPanel";
import { frameOrderAtom, peekAtom } from "../state/boardUi";
import { focusedCardAtom, useBoardForYou } from "../state/forYou";
import { useBoardView } from "../state/boardView";
import type { ValidBoard } from "../store/boardFiles";
import { ForYouLane } from "./ForYouLane";
import { Lanes } from "./Lanes";
import { forYouHeight, layoutBoard } from "./layout";
import { OrchestratorCard } from "./OrchestratorCard";
import { PeekDrawer } from "./PeekDrawer";
import { Viewport } from "./Viewport";

const NO_ORDER = {};

/** A board's orchestrator card and lanes on the canvas, the peek drawer over it, and the orchestrator's panel beside it. */
export function BoardScreen({
  project,
  listed,
}: {
  project: EnvironmentProject;
  listed: ValidBoard;
}) {
  const registry = useContext(RegistryContext);
  const { board } = listed;
  const { model, issue, stats } = useBoardView(project, listed);
  const order = useAtomValue(frameOrderAtom)[board.id] ?? NO_ORDER;
  const forYou = useBoardForYou(project, listed);
  const artifacts = useBoardArtifacts(project, listed, model);
  const layout = useMemo(
    () => layoutBoard(model, order, forYouHeight(forYou.views), artifacts.cards),
    [model, order, forYou.views, artifacts.cards],
  );
  const peek = useAtomValue(peekAtom);
  const focused = useAtomValue(focusedCardAtom);
  const focusedId =
    focused?.boardId === board.id && forYou.views.some((view) => view.card.id === focused.cardId)
      ? focused.cardId
      : null;
  return (
    <ArtifactsProvider value={artifacts.value}>
      <div className="flex h-full min-h-0">
        <div className="relative min-w-0 flex-1">
          <Viewport content={layout.content}>
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
          {artifacts.viewing !== null && (
            <ArtifactViewer artifact={artifacts.viewing} onClose={artifacts.closeViewer} />
          )}
        </div>
        <OrchestratorPanel project={project} listed={listed} />
      </div>
    </ArtifactsProvider>
  );
}
