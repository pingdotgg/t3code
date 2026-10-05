import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

const IMAGE = "us-docker.pkg.dev/cloudrun/container/hello";
const WORKER_IMAGE = "us-docker.pkg.dev/cloudrun/container/worker-pool";

/** Service `GetService` reads (roles/run.viewer). */
export const Api = GCP.Run.Service("Api", {
  location: "us-central1",
  template: { containers: [{ image: IMAGE }] },
});

/** Private service `InvokeService` calls (roles/run.invoker). */
export const Callee = GCP.Run.Service("Callee", {
  location: "us-central1",
  template: { containers: [{ image: IMAGE }] },
});

/** Worker pool `GetWorkerPool` reads (roles/run.viewer). */
export const Workers = GCP.Run.WorkerPool("Workers", {
  location: "us-central1",
  template: { containers: [{ image: WORKER_IMAGE }] },
});

/** Job `RunJob` executes (roles/run.jobsExecutorWithOverrides). */
export const Migrate = GCP.Run.Job("Migrate", {
  location: "us-central1",
  containers: [{ image: "us-docker.pkg.dev/cloudrun/container/job:latest" }],
});

/**
 * Effect-native Cloud Run service exercising every Cloud Run binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class RunBindingsHost extends GCP.Function<RunBindingsHost>()(
  "RunBindingsHost",
  { main: import.meta.url, location: "us-central1", invokerIamDisabled: true },
  Effect.gen(function* () {
    const getService = yield* GCP.Run.GetService(Api);
    const getWorkerPool = yield* GCP.Run.GetWorkerPool(Workers);
    const runJob = yield* GCP.Run.RunJob(Migrate);
    const callee = yield* GCP.Run.InvokeService(Callee);

    return {
      fetch: serveProbes({
        getService: getService(),
        getWorkerPool: getWorkerPool(),
        runJob: runJob(),
        invokeService: Effect.gen(function* () {
          const response = yield* callee.fetch("/");
          return { status: response.status, text: yield* response.text };
        }),
      }),
    };
  }).pipe(
    Effect.provide(GCP.Run.GetServiceHttp),
    Effect.provide(GCP.Run.GetWorkerPoolHttp),
    Effect.provide(GCP.Run.RunJobHttp),
    Effect.provide(GCP.Run.InvokeServiceHttp),
  ),
) {}
