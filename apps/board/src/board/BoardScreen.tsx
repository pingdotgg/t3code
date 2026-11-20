import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { TriangleAlert } from "lucide-react";
import { useContext, useMemo } from "react";

import { OrchestratorPanel } from "../chat/OrchestratorPanel";
import { frameOrderAtom, peekAtom } from "../state/boardUi";
import { useBoardView } from "../state/boardView";
import type { ValidBoard } from "../store/boardFiles";
import { Lanes } from "./Lanes";
import { layoutBoard } from "./layout";
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
  const layout = useMemo(() => layoutBoard(model, order), [model, order]);
  const peek = useAtomValue(peekAtom);
  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
        <Viewport content={layout.content}>
          <OrchestratorCard project={project} listed={listed} stats={stats} />
          <Lanes
            layout={layout}
            model={model}
            boardId={board.id}
            forYouOpen={stats.forYouOpen}
            peek={peek}
            onPeek={(next) => registry.set(peekAtom, next)}
          />
        </Viewport>
        {issue !== null && (
          <div
            role="alert"
            data-testid="tickets-banner"
            className="absolute bottom-3.5 left-3.5 z-10 flex max-w-[60%] items-start gap-2 rounded-lg border border-red-400/40 bg-panel px-3 py-2 text-red-300 shadow-panel"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="min-w-0">
              <p className="font-semibold">
                tickets.json has a bad {issue.fields.length === 1 ? "field" : "fields"}
                {issue.fields.length > 0 ? `: ${issue.fields.join(", ")}` : ""}. Showing the last
                valid layout.
              </p>
              <p className="text-[11px] break-words text-red-300/80">{issue.message}</p>
            </div>
          </div>
        )}
        <PeekDrawer
          environmentId={project.environmentId}
          model={model}
          peek={peek}
          onClose={() => registry.set(peekAtom, null)}
        />
      </div>
      <OrchestratorPanel project={project} listed={listed} />
    </div>
  );
}
