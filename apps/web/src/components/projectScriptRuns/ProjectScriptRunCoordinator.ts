import type { TerminalBufferState } from "@t3tools/client-runtime/state/terminal";
import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
} from "@t3tools/client-runtime/state/terminal";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";

import {
  isProjectScriptRunActive,
  isProjectScriptWrapperLine,
  PROJECT_SCRIPT_OUTPUT_TAIL_LINES,
  projectScriptBeginMarker,
  projectScriptSentinelPattern,
  stripProjectScriptOutput,
  type ProjectScriptRun,
  type ProjectScriptRunPatch,
} from "../../projectScriptRuns";
import { useProjectScriptRunsStore } from "../../projectScriptRunsStore";
import { terminalEnvironment } from "../../state/terminal";

const LOST_TERMINAL_GRACE_MS = 5_000;

export function startProjectScriptRunCoordinator(registry: AtomRegistry.AtomRegistry): () => void {
  const watchers = new Map<string, () => void>();
  const sync = (runs: Record<string, ProjectScriptRun>) => {
    for (const [runId, stop] of watchers) {
      const run = runs[runId];
      if (run !== undefined && isProjectScriptRunActive(run)) continue;
      watchers.delete(runId);
      stop();
    }
    for (const run of Object.values(runs)) {
      if (!isProjectScriptRunActive(run) || watchers.has(run.id)) continue;
      watchers.set(run.id, watchProjectScriptRun(registry, run));
    }
  };

  sync(useProjectScriptRunsStore.getState().runs);
  const unsubscribe = useProjectScriptRunsStore.subscribe((state, previous) => {
    if (state.runs !== previous.runs) sync(state.runs);
  });

  return () => {
    unsubscribe();
    for (const stop of watchers.values()) stop();
    watchers.clear();
  };
}

function watchProjectScriptRun(
  registry: AtomRegistry.AtomRegistry,
  run: ProjectScriptRun,
): () => void {
  const atom = terminalEnvironment.observe({
    environmentId: run.environmentId,
    input: { threadId: run.threadId, terminalId: run.terminalId },
  });
  const sentinelPattern = projectScriptSentinelPattern(run.sentinel);
  const beginMarker = projectScriptBeginMarker(run.sentinel);
  let cursor = INITIAL_TERMINAL_OUTPUT_CURSOR;
  let lineBuffer = "";
  let tail: string[] = [];
  let sawBegin = false;
  let sawLive = false;
  let stopped = false;
  let unsubscribe: (() => void) | null = null;
  let lostTimer: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (lostTimer !== null) {
      clearTimeout(lostTimer);
      lostTimer = null;
    }
    unsubscribe?.();
  };

  const settle = (patch: ProjectScriptRunPatch) => {
    if (stopped) return;
    useProjectScriptRunsStore.getState().updateRun(run.id, {
      ...patch,
      outputTail: tail.slice(-PROJECT_SCRIPT_OUTPUT_TAIL_LINES).join("\n"),
      endedAt: Date.now(),
    });
    stop();
  };

  lostTimer = setTimeout(() => {
    if (!stopped && !sawLive) {
      settle({ status: "lost", errorMessage: "The terminal is no longer available." });
    }
  }, LOST_TERMINAL_GRACE_MS);

  const handleLine = (rawLine: string): boolean => {
    const sentinel = sentinelPattern.exec(rawLine);
    if (sentinel !== null) {
      const parsed = Number(sentinel[1]);
      const exitCode = Number.isFinite(parsed) ? parsed : null;
      settle({
        status: exitCode === 0 ? "succeeded" : "failed",
        exitCode,
        errorMessage:
          exitCode === 0 ? null : (tail.at(-1) ?? `Exited with code ${exitCode ?? "unknown"}.`),
      });
      return true;
    }
    if (!sawBegin) {
      if (rawLine.includes(beginMarker)) sawBegin = true;
      return false;
    }
    const cleaned = stripProjectScriptOutput(rawLine).trimEnd();
    if (cleaned.length === 0 || isProjectScriptWrapperLine(cleaned)) return false;
    tail.push(cleaned.slice(0, 400));
    if (tail.length > PROJECT_SCRIPT_OUTPUT_TAIL_LINES) tail.shift();
    return false;
  };

  const onResult = (result: AsyncResult.AsyncResult<TerminalBufferState, unknown>) => {
    if (stopped) return;
    if (result._tag === "Failure") {
      if (sawLive) {
        settle({ status: "lost", errorMessage: "The terminal is no longer available." });
      }
      return;
    }
    if (result._tag !== "Success") return;
    const state = result.value;
    if (state.status === "error") {
      settle({
        status: "failed",
        errorMessage: state.error ?? "The terminal failed to start.",
      });
      return;
    }
    if (state.status === "exited") {
      settle({
        status: "failed",
        errorMessage: "The terminal exited before the command reported a result.",
      });
      return;
    }
    if (state.status === "closed") {
      if (sawLive) {
        settle({
          status: "lost",
          errorMessage: "The terminal closed before the command reported a result.",
        });
      }
      return;
    }

    sawLive = true;
    if (lostTimer !== null) {
      clearTimeout(lostTimer);
      lostTimer = null;
    }
    if (
      state.status === "running" &&
      useProjectScriptRunsStore.getState().runs[run.id]?.status === "starting"
    ) {
      useProjectScriptRunsStore.getState().updateRun(run.id, { status: "running" });
    }

    const update = readTerminalOutputUpdate(state.output, cursor);
    cursor = update.cursor;
    if (update.type === "reset") {
      lineBuffer = "";
      tail = [];
    }
    if (update.type === "none") return;
    lineBuffer += update.data;
    const lines = lineBuffer.split(/\r\n|\r|\n/);
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (handleLine(line)) return;
    }
  };

  unsubscribe = registry.subscribe(atom, onResult, { immediate: true });
  if (stopped) unsubscribe();
  return stop;
}
