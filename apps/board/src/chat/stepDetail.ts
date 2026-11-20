import { useAtomValue } from "@effect/atom-react";
import { turnItemOutputText } from "@t3tools/client-runtime/work-log/item-detail";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { turnItemAtom } from "../state/threads";
import type { ToolStep } from "./timeline";

const NO_ITEM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("board-turn-item:none"),
);

export interface StepDetail {
  readonly output: string | null;
  readonly diff: string | null;
  readonly state: "ready" | "loading" | "unavailable";
}

/** What a step printed or changed: from the thread when the engine sent it, else fetched from the engine. */
export function useStepDetail(environmentId: EnvironmentId, step: ToolStep): StepDetail {
  const ref = step.outputRef;
  const result = useAtomValue(ref === null ? NO_ITEM : turnItemAtom({ environmentId, input: ref }));
  if (ref === null) return { output: step.output, diff: null, state: "ready" };
  if (result._tag === "Failure") return { output: step.output, diff: null, state: "unavailable" };
  const item = Option.getOrNull(AsyncResult.value(result))?.item;
  if (item === undefined) return { output: step.output, diff: null, state: "loading" };
  if (item === null) return { output: step.output, diff: null, state: "unavailable" };
  return {
    output: turnItemOutputText(item) ?? step.output,
    diff: item.type === "file_change" ? (item.diffStr?.trim() ?? null) : null,
    state: "ready",
  };
}

/** The added and removed lines of a unified diff, which the engine leaves uncounted for some edits. */
export function diffCounts(diff: string) {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}
