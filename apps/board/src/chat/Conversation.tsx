import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { MessageId, type ThreadId } from "@t3tools/contracts";
import { SendHorizontal, Square } from "lucide-react";
import * as Option from "effect/Option";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { failureText } from "../settings/failureText";
import { newId } from "../state/boards";
import {
  environmentThreads,
  interruptTurn,
  startTurn,
  useEnvironmentThread,
} from "../state/threads";
import type { ValidBoard } from "../store/boardFiles";
import { PanelHeader } from "./PanelHeader";
import { timelineSource } from "./projectionSource";
import { isRunLive, timelineRows } from "./timeline";
import { TimelineRowView } from "./TimelineRowView";
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

  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (text === "" || projection === null) return;
    setError(null);
    setDraft("");
    const result = await runAtomCommand(
      registry,
      startTurn,
      {
        environmentId,
        input: {
          threadId,
          message: { messageId: MessageId.make(newId()), role: "user", text, attachments: [] },
          runtimeMode: projection.thread.runtimeMode,
          interactionMode: projection.thread.interactionMode,
        },
      },
      { reportFailure: false },
    );
    if (result._tag !== "Success") {
      setDraft(text);
      setError(failureText(result));
    }
  };

  const stop = async () => {
    setError(null);
    const result = await runAtomCommand(
      registry,
      interruptTurn,
      { environmentId, input: { threadId } },
      { reportFailure: false },
    );
    if (result._tag !== "Success") setError(failureText(result));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      void send();
      event.preventDefault();
    }
  };

  return (
    <>
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
          <TimelineRowView key={row.id} row={row} brief={index === 0 && row.kind === "user"} />
        ))}
        {live && rows.at(-1)?.kind === "user" && <p className="text-faint">Thinking</p>}
      </div>
      <form onSubmit={(event) => void send(event)} className="shrink-0 border-t border-line p-2">
        {error !== null && (
          <p role="alert" className="mb-1.5 break-words text-red-400">
            {error}
          </p>
        )}
        <div className="flex items-end gap-2 rounded-xl border border-line bg-panel p-2 focus-within:border-muted">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder="Message the orchestrator"
            aria-label="Message the orchestrator"
            className="max-h-40 min-h-10 min-w-0 flex-1 resize-none bg-transparent text-fg outline-none placeholder:text-faint"
          />
          {live && draft.trim() === "" ? (
            <button
              type="button"
              aria-label="Stop"
              onClick={() => void stop()}
              className="grid size-7 shrink-0 place-items-center rounded-full bg-fg text-bg"
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              disabled={draft.trim() === ""}
              className="grid size-7 shrink-0 place-items-center rounded-full bg-fg text-bg disabled:opacity-40"
            >
              <SendHorizontal className="size-3.5" />
            </button>
          )}
        </div>
      </form>
    </>
  );
}
