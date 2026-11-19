import agentDebug from "./no-agent-debug-instrumentation.mjs";
import enumPropertyTypes from "./enum-property-types.mjs";
import fixedSleep from "./no-fixed-sleep.mjs";
import processEnv from "./no-process-env-outside-runtime-profile.mjs";
import sharedWorkerState from "./no-shared-worker-state.mjs";
import unboundedFanOut from "./no-unbounded-promise-fan-out.mjs";
import unsignaledPoll from "./no-unsignaled-poll.mjs";
import useEffect from "./no-use-effect.mjs";

export default {
  meta: { name: "project" },
  rules: {
    ...agentDebug.rules,
    ...enumPropertyTypes.rules,
    ...fixedSleep.rules,
    ...processEnv.rules,
    ...sharedWorkerState.rules,
    ...unboundedFanOut.rules,
    ...unsignaledPoll.rules,
    ...useEffect.rules,
  },
};
