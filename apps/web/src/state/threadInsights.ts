import { Atom, AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  mergeThreadInsights,
  type ThreadInsightsAnswer,
} from "@t3tools/client-runtime/state/thread-insights";
import { orchestrationEnvironment } from "./orchestration";
import { environmentPresentations } from "./presentation";
import { environmentThreadShells } from "./threads";
import { createThreadInsightsRefreshAtom } from "./threadInsightsRefresh";

export const threadInsightsViewAtom = Atom.family((key: string) => {
  const target = parseScopedThreadKey(key);
  if (target === null) throw new Error("Invalid thread insights target");
  const view = Atom.make((get) => {
    const configs = get(environmentPresentations.serverConfigsAtom);
    const answers = new Map<string, ThreadInsightsAnswer>();
    const queue = [target];
    const visited = new Set<string>();
    const queries: ReturnType<typeof orchestrationEnvironment.threadInsights>[] = [];
    const errors = new Set<string>();
    let loading = false;
    for (let index = 0; index < queue.length && visited.size < 200; index++) {
      const ref = queue[index]!;
      const nextKey = scopedThreadKey(ref);
      if (visited.has(nextKey)) continue;
      visited.add(nextKey);
      if (configs.get(ref.environmentId)?.threadInsights !== true) continue;
      const query = orchestrationEnvironment.threadInsights({
        environmentId: ref.environmentId,
        input: { threadId: ref.threadId },
      });
      queries.push(query);
      const result = get(query);
      loading ||= AsyncResult.isInitial(result) || result.waiting;
      if (AsyncResult.isFailure(result)) {
        errors.add("An environment could not report tasks and usage.");
      }
      const data = Option.getOrNull(AsyncResult.value(result));
      if (data === null) continue;
      answers.set(nextKey, { target: ref, data });
      queue.push(...data.remotes);
    }
    return { ...mergeThreadInsights(target, answers), queries, errors: [...errors], loading };
  });
  const revisions = Atom.make((get) => {
    const data = get(view);
    const refs = [target, ...data.rows, ...data.pending];
    return new Map(
      refs.map((ref) => [
        scopedThreadKey(ref),
        get(environmentThreadShells.threadShellAtom(ref))?.updatedAt,
      ]),
    );
  });
  const refresh = createThreadInsightsRefreshAtom(revisions, (registry) => {
    for (const query of registry.get(view).queries) registry.refresh(query);
  });
  return Atom.make((get) => {
    get(refresh);
    return get(view);
  });
});
