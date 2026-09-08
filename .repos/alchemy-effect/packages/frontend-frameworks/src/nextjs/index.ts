import { make, type NextjsFrameworkOptions } from "./Nextjs.ts";

export {
  BundleError,
  bundleWorker,
  CREATE_REQUIRE_BANNER,
  makeWranglerExternalsPlugin,
  WORKER_ENTRY_NAME,
  type BundleWorkerOptions,
  type BundleWorkerResult,
} from "./Bundle.ts";
export {
  DEFAULT_COMPATIBILITY_DATE,
  DO_QUEUE_BINDING,
  DO_QUEUE_CLASS,
  hasDoQueueClass,
  make,
  makeRunnerConfig,
  SELF_REFERENCE_BINDING,
  toRuntimeModules,
  WORKER_ENTRY_MODULE,
  type NextjsFrameworkOptions,
  type NextjsWorkerConfig,
} from "./Nextjs.ts";
export {
  RunnerError,
  runnerPath,
  runOpenNextBuild,
  type RunnerConfig,
} from "./Runner.ts";
export * as DevServer from "./DevServer.ts";

/**
 * The e2e-harness framework factory contract: default-export a
 * `(options) => Layer<Framework>` factory that reads the cloudflare worker
 * configuration from `options.vite`.
 */
const framework = (options?: NextjsFrameworkOptions) => make(options);

export default framework;
