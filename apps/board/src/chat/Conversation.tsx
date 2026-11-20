import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import { environmentThreads, useEnvironmentThread } from "../state/threads";
import type { ValidBoard } from "../store/boardFiles";
import { useArtifacts } from "../artifacts/ArtifactsContext";
import { ArtifactLookup, ArtifactLookupContext } from "./artifactLookup";
import { Composer } from "./Composer";
import { PanelHeader } from "./PanelHeader";
import { timelineSource } from "./projectionSource";
import { isRunLive, timelineRows } from "./timeline";
import { TimelineRowView } from "./TimelineRowView";
import { SkillsContext, useThreadSkills } from "./skills";
import { MARK_TOKENS, watchTokens } from "./tokenMarks";

const NO_UNSUBSCRIBE = () => undefined;

function statusOf(
  runs: ReadonlyArray<{ readonly id: string; readonly status: string }> | undefined,
): string {
  if (runs === undefined) return "Connecting";
  const last = runs.at(-1)?.status;
  if (isRunLive({ runs })) return "Working";
  if (last === "failed") return "Failed";
  return last === "interrupted" || last === "cancelled" ? "Stopped" : "Idle";
}

/** The orchestrator's thread, streamed, with the box that sends a follow-up or stops the turn. */
export function Conversation({
  project,
  listed,
  threadId,
}: {
  project: EnvironmentProject;
  listed: ValidBoard;
  threadId: ThreadId;
}) {
  const registry = useContext(RegistryContext);
  const { environmentId } = project;
  const state = useEnvironmentThread(environmentId, threadId);
  const projection = Option.getOrNull(state.data);
  const live = projection !== null && isRunLive(projection);
  const rows = useMemo(
    () => (projection === null ? [] : timelineRows(timelineSource(projection))),
    [projection],
  );
  const failure = Option.getOrNull(state.error);
  const { all: artifacts, open: openArtifact } = useArtifacts();
  const lookup = useMemo(() => new ArtifactLookup(), []);
  useLayoutEffect(() => lookup.update(artifacts, openArtifact), [lookup, artifacts, openArtifact]);
  const skills = useThreadSkills(project, projection?.thread.modelSelection.instanceId);

  // A token is stamped as it reaches the thread state, ahead of the render that paints it.
  const stateAtom = environmentThreads.stateAtom(environmentId, threadId);
  useSyncExternalStore(
    useCallback(
      () => (MARK_TOKENS ? watchTokens(registry, stateAtom) : NO_UNSUBSCRIBE),
      [registry, stateAtom],
    ),
    () => null,
  );

  // Follows the newest row while the reader is at the bottom, and stays put once they scroll up.
  // It runs after every commit, because a streaming reply grows a row without adding one.
  const scroller = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && atBottom.current) element.scrollTop = element.scrollHeight;
  });

  return (
    <SkillsContext value={skills}>
      <ArtifactLookupContext value={lookup}>
        <PanelHeader title={listed.board.name} status={statusOf(projection?.runs)} />
        <div
          ref={scroller}
          data-testid="orchestrator-timeline"
          onScroll={(event) => {
            const element = event.currentTarget;
            atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
          }}
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
        >
          {projection === null && failure !== null && (
            <p role="alert" className="text-red-400">
              {failure}
            </p>
          )}
          {projection === null && failure === null && (
            <p className="text-faint">Connecting to the orchestrator</p>
          )}
          {rows.map((row, index) => (
            <TimelineRowView
              key={row.id}
              row={row}
              brief={index === 0 && row.kind === "user"}
              environmentId={environmentId}
            />
          ))}
          {live && rows.at(-1)?.kind === "user" && <p className="text-faint">Thinking</p>}
        </div>
        <Composer project={project} threadId={threadId} projection={projection} live={live} />
      </ArtifactLookupContext>
    </SkillsContext>
  );
}
