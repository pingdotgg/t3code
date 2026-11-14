import { Atom, AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  mergeThreadInsights,
  type ThreadInsightsAnswer,
} from "@t3tools/client-runtime/state/thread-insights";
import { orchestrationEnvironment } from "./orchestration";
import { environmentPresentations } from "./presentation";

export const threadInsightsViewAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const target = parseScopedThreadKey(key);
    if (target === null) throw new Error("Invalid thread insights target");
    const configs = get(environmentPresentations.serverConfigsAtom);
    const answers = new Map<string, ThreadInsightsAnswer>();
    const queue = [target];
    const visited = new Set<string>();
    const queries: ReturnType<typeof orchestrationEnvironment.threadInsights>[] = [];
    const errors = new Set<string>();
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
      if (AsyncResult.isFailure(result)) {
        errors.add("An environment could not report tasks and usage.");
        continue;
      }
      const data = Option.getOrNull(AsyncResult.value(result));
      if (data === null) continue;
      answers.set(nextKey, { target: ref, data });
      queue.push(...data.remotes);
    }
    return { ...mergeThreadInsights(target, answers), queries, errors: [...errors] };
  }),
);
