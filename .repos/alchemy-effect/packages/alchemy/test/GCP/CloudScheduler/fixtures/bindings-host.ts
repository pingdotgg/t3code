import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

const job = (id: string) =>
  GCP.CloudScheduler.Job(id, {
    schedule: "0 0 1 1 *",
    timeZone: "UTC",
    httpTarget: { uri: "https://example.com/", httpMethod: "GET" },
  });

/** Job {@link GCP.CloudScheduler.PauseJob} binds. */
export const PausedJob = job("PausedJob");
/** Job {@link GCP.CloudScheduler.ResumeJob} binds (paused by the test first). */
export const ResumedJob = job("ResumedJob");
/** Job {@link GCP.CloudScheduler.RunJob} binds. */
export const RunJobTarget = job("RunJobTarget");

/**
 * Effect-native Cloud Run service exercising every Cloud Scheduler binding as
 * its own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class SchedulerBindingsHost extends GCP.Function<SchedulerBindingsHost>()(
  "SchedulerBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const pauseJob = yield* GCP.CloudScheduler.PauseJob(PausedJob);
    const resumeJob = yield* GCP.CloudScheduler.ResumeJob(ResumedJob);
    const runJob = yield* GCP.CloudScheduler.RunJob(RunJobTarget);

    return {
      fetch: serveProbes({
        pause: pauseJob(),
        resume: resumeJob(),
        run: runJob(),
      }),
    };
  }).pipe(
    Effect.provide(GCP.CloudScheduler.PauseJobHttp),
    Effect.provide(GCP.CloudScheduler.ResumeJobHttp),
    Effect.provide(GCP.CloudScheduler.RunJobHttp),
  ),
) {}
