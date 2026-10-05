import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as composer from "@distilled.cloud/gcp/composer_v1";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import ComposerBindingsHost, {
  Airflow,
  TaskConfig,
  TaskSecret,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ComposerBindings");

// Composer environments take 20-45 minutes to provision.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

let baseUrl: string;
let hostAccount: string;
let environmentName: string;
let configMapName: string;
let secretName: string;

/**
 * Composer has no resource-level IAM, so its bindings grant on the project:
 * `composer.viewer` (the Get* bindings) and `composer.editor`
 * (ExecuteAirflowCommand — the narrowest role holding
 * `composer.environments.executeAirflowCommand`).
 */
const expectProjectGrants = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const policy = yield* crm.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  const grants = (policy.bindings ?? [])
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => ({
      role: binding.role,
      condition: binding.condition?.expression,
    }))
    .sort((a, b) => (a.role ?? "").localeCompare(b.role ?? ""));
  expect(grants).toEqual([
    { role: "roles/composer.editor", condition: undefined },
    { role: "roles/composer.viewer", condition: undefined },
  ]);
});

describe.skipIf(!dockerAvailable || !runLifecycle)(
  "Composer Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:composer", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* ComposerBindingsHost;
            const environment = yield* Airflow;
            const config = yield* TaskConfig;
            const secret = yield* TaskSecret;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              environment: environment.name,
              config: config.name,
              secret: secret.name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        environmentName = out.environment;
        configMapName = out.config;
        secretName = out.secret;
      }),
      // Composer environment create alone can take ~45 minutes.
      { timeout: 5_400_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 3_600_000 });

    describe("GetEnvironment", () => {
      test.provider(
        "reads the environment as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const environment = yield* expectProbe<composer.Environment>(
              baseUrl,
              "getEnvironment",
            );
            const live = yield* composer.getProjectsLocationsEnvironments({
              name: environmentName,
            });
            expect(environment.name).toEqual(environmentName);
            expect(environment.uuid).toEqual(live.uuid);
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:composer", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ExecuteAirflowCommand", () => {
      test.provider(
        "runs `airflow version` as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const started =
              yield* expectProbe<composer.ExecuteAirflowCommandResponse>(
                baseUrl,
                "executeAirflowCommand",
              );
            expect(started.error ?? "").toEqual("");
            expect(started.executionId).toEqual(expect.any(String));

            // The execution is visible out of band and finishes cleanly.
            const polled = yield* composer
              .pollAirflowCommandProjectsLocationsEnvironments({
                environment: environmentName,
                body: {
                  executionId: started.executionId,
                  pod: started.pod,
                  podNamespace: started.podNamespace,
                  // The API rejects a missing or zero line number.
                  nextLineNumber: 1,
                },
              })
              .pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("5 seconds"),
                  until: (response) => response.outputEnd === true,
                  times: 24,
                }),
              );
            expect(polled.exitInfo?.exitCode ?? 0).toEqual(0);
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:composer", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetUserWorkloadsConfigMap", () => {
      test.provider(
        "reads the ConfigMap as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const configMap =
              yield* expectProbe<composer.UserWorkloadsConfigMap>(
                baseUrl,
                "getUserWorkloadsConfigMap",
              );
            expect(configMap.name).toEqual(configMapName);
            expect(configMap.data).toEqual({ LOG_LEVEL: "INFO" });
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:composer", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetUserWorkloadsSecret", () => {
      test.provider(
        "reads the Secret as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const secret = yield* expectProbe<composer.UserWorkloadsSecret>(
              baseUrl,
              "getUserWorkloadsSecret",
            );
            expect(secret.name).toEqual(secretName);
            // Composer redacts secret values on read; the key survives.
            expect(Object.keys(secret.data ?? {})).toEqual(["password"]);
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:composer", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
