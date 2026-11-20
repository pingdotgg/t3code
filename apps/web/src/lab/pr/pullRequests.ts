// Lab stub: the PR queries the panel and its tabs read answer from the fixture.
import * as actual from "~/state/pullRequests";
import { AsyncResult, Atom } from "effect/reactivity";
import { LAB_DIFF as MOCKUP_DIFF, LAB_PULL_REQUEST as MOCKUP_PULL_REQUEST } from "./fixture";

export * from "~/state/pullRequests";

const answer = <A>(value: A) => Atom.make(AsyncResult.success(value));
const diff = answer({ patch: MOCKUP_DIFF, truncated: false, nextCursor: null });
const detail = answer(MOCKUP_PULL_REQUEST);
const checks = answer({ state: MOCKUP_PULL_REQUEST.state, checks: MOCKUP_PULL_REQUEST.checks });

const overrides: Record<string, unknown> = {
  detail: () => detail,
  diff: () => diff,
  checks: () => checks,
};

export const pullRequestEnvironment = new Proxy(actual.pullRequestEnvironment, {
  get(target, key, receiver) {
    return typeof key === "string" && key in overrides
      ? overrides[key]
      : Reflect.get(target, key, receiver);
  },
}) as typeof actual.pullRequestEnvironment;
