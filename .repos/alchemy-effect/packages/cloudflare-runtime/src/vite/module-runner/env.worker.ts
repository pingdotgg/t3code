import type { EntryEnvironment } from "./constants.shared.ts";
import type { ModuleRunnerDO } from "./module-runner.worker.ts";

export interface Env extends Cloudflare.Env {
  __DISTILLED_MODULE_RUNNER__: {
    get(id: "singleton"): ModuleRunnerDO;
  };
  __DISTILLED_UNSAFE_EVAL__: {
    eval: (code: string, id: string) => Function;
  };
  __DISTILLED_INVOKE_MODULE__: Fetcher;
  __DISTILLED_ENVIRONMENT__: EntryEnvironment;
  __DISTILLED_MODULE_FALLBACK__: Fetcher;
  [key: string]: unknown;
}

export function stripInternalEnv(env: Env) {
  const {
    __DISTILLED_MODULE_RUNNER__,
    __DISTILLED_UNSAFE_EVAL__,
    __DISTILLED_INVOKE_MODULE__,
    __DISTILLED_ENVIRONMENT__,
    __DISTILLED_MODULE_FALLBACK__,
    ...userEnv
  } = env;
  return userEnv;
}
