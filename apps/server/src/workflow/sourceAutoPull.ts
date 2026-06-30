import * as Effect from "effect/Effect";
import type { PredicateEvaluatorShape } from "./Services/PredicateEvaluator.ts";
import type { SourceDelta, SourceItemFields } from "./Services/WorkflowSourceCommitter.ts";

export interface ItemRuleContext {
  readonly title: string;
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
  readonly state: "open" | "closed";
  readonly provider: string;
}

export const buildItemRuleContext = (item: SourceItemFields): ItemRuleContext => ({
  title: item.title,
  body: item.description ?? "",
  labels: item.metadata.labels ?? [],
  assignees: item.metadata.assignees ?? [],
  state: item.metadata.lifecycle === "open" ? "open" : "closed",
  provider: item.provider,
});

export const gateNewDeltas = (
  deltas: ReadonlyArray<SourceDelta>,
  rule: unknown | null,
  evaluator: Pick<PredicateEvaluatorShape, "evaluate">,
): Effect.Effect<ReadonlyArray<SourceDelta>, never> =>
  Effect.gen(function* () {
    const out: Array<SourceDelta> = [];
    for (const delta of deltas) {
      if (delta._tag !== "new") {
        out.push(delta);
        continue;
      }
      if (rule === null) continue;
      const ev = yield* evaluator
        .evaluate(rule, buildItemRuleContext(delta.item))
        .pipe(Effect.orElseSucceed(() => ({ result: false, matchedPaths: [] }))); // bad rule → no auto-create (lint prevents this)
      if (ev.result) out.push(delta);
    }
    return out;
  });
