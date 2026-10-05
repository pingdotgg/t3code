import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

export const OnPrem = GCP.RapidMigrationAssessment.Collector("BindOnPrem", {
  location: "us-central1",
  displayName: "bind collector",
  collectionDays: 7,
  expectedAssetCount: 1,
  labels: { env: "bind" },
});

/**
 * Effect-native Cloud Run service exercising every Rapid Migration
 * Assessment binding as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class RmaBindingsHost extends GCP.Function<RmaBindingsHost>()(
  "RmaBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const pause = yield* GCP.RapidMigrationAssessment.PauseCollector(OnPrem);
    const resume = yield* GCP.RapidMigrationAssessment.ResumeCollector(OnPrem);
    const register =
      yield* GCP.RapidMigrationAssessment.RegisterCollector(OnPrem);

    return {
      fetch: serveProbes({
        pause: pause(),
        resume: resume(),
        register: register(),
      }),
    };
  }).pipe(
    Effect.provide(GCP.RapidMigrationAssessment.PauseCollectorHttp),
    Effect.provide(GCP.RapidMigrationAssessment.ResumeCollectorHttp),
    Effect.provide(GCP.RapidMigrationAssessment.RegisterCollectorHttp),
  ),
) {}
