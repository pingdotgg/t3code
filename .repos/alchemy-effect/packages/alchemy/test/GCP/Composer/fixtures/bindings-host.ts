import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { serveProbes } from "../../bindingHost.ts";
import { defaultComputeServiceAccount } from "../serviceAccount.ts";
import { CAPACITY_REGION } from "../../zones.ts";

/** Environment GetEnvironment / ExecuteAirflowCommand are bound to. */
export const Airflow = Effect.gen(function* () {
  // GcpEnvironment exists at deploy time only; the deployed host never
  // reconciles props, so the placeholder is an equivalent stand-in there.
  const env = yield* Effect.serviceOption(GcpEnvironment);
  const serviceAccount = Option.isSome(env)
    ? // A missing project or lookup failure aborts the test deploy itself.
      yield* defaultComputeServiceAccount.pipe(Effect.orDie)
    : "runtime-placeholder";
  return yield* GCP.Composer.Environment("Airflow", {
    location: CAPACITY_REGION,
    config: {
      environmentSize: "ENVIRONMENT_SIZE_SMALL",
      nodeConfig: { serviceAccount },
      softwareConfig: { imageVersion: "composer-3-airflow-2" },
    },
  });
});

/** User-workloads ConfigMap GetUserWorkloadsConfigMap reads. */
export const TaskConfig = Effect.gen(function* () {
  const environment = yield* Airflow;
  return yield* GCP.Composer.EnvironmentsUserWorkloadsConfigMap("TaskConfig", {
    environmentName: environment.name,
    data: { LOG_LEVEL: "INFO" },
  });
});

/** User-workloads Secret GetUserWorkloadsSecret reads. */
export const TaskSecret = Effect.gen(function* () {
  const environment = yield* Airflow;
  return yield* GCP.Composer.EnvironmentsUserWorkloadsSecret("TaskSecret", {
    environmentName: environment.name,
    data: { password: btoa("s3cret") },
  });
});

/**
 * Effect-native Cloud Run service exercising every Cloud Composer binding
 * as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class ComposerBindingsHost extends GCP.Function<ComposerBindingsHost>()(
  "ComposerBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const environment = yield* Airflow;
    const getEnvironment = yield* GCP.Composer.GetEnvironment(environment);
    const execute = yield* GCP.Composer.ExecuteAirflowCommand(environment);
    const getConfigMap = yield* GCP.Composer.GetUserWorkloadsConfigMap(
      yield* TaskConfig,
    );
    const getSecret = yield* GCP.Composer.GetUserWorkloadsSecret(
      yield* TaskSecret,
    );

    return {
      fetch: serveProbes({
        getEnvironment: getEnvironment(),
        executeAirflowCommand: execute({ body: { command: "version" } }),
        getUserWorkloadsConfigMap: getConfigMap(),
        getUserWorkloadsSecret: getSecret(),
      }),
    };
  }).pipe(
    Effect.provide(GCP.Composer.GetEnvironmentHttp),
    Effect.provide(GCP.Composer.ExecuteAirflowCommandHttp),
    Effect.provide(GCP.Composer.GetUserWorkloadsConfigMapHttp),
    Effect.provide(GCP.Composer.GetUserWorkloadsSecretHttp),
  ),
) {}
