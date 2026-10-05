import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as bqdt from "@distilled.cloud/gcp/bigquerydatatransfer_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import BigQueryDataTransferBindingsHost, {
  Nightly,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(
  testOptions,
  "BigQueryDataTransferBindings",
);

let baseUrl: string;
let configName: string;
let hostAccount: string;

/** Every project-level role (and its IAM Condition) `account` holds. */
const projectGrantsOf = (account: string) =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;
    const policy = yield* resourcemanager.getIamPolicyProjects({
      resource: `projects/${project}`,
      body: { options: { requestedPolicyVersion: 3 } },
    });
    return (policy.bindings ?? [])
      .filter((binding) =>
        (binding.members ?? []).includes(`serviceAccount:${account}`),
      )
      .map((binding) => ({
        role: binding.role,
        condition: binding.condition?.expression,
      }));
  });

describe.skipIf(!dockerAvailable)(
  "BigQueryDataTransfer Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:bigquerydatatransfer",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* BigQueryDataTransferBindingsHost;
            const config = yield* Nightly;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              config: config.name,
            };
          }),
        );
        baseUrl = out.uri!;
        configName = out.config;
        hostAccount = out.serviceAccount!;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("StartManualRuns", () => {
      test.provider(
        "starts a run as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const out =
              yield* expectProbe<bqdt.StartManualTransferRunsResponse>(
                baseUrl,
                "startManualRuns",
              );
            expect(out.runs).toHaveLength(1);
            const runName = out.runs?.[0]?.name ?? "";
            expect(runName.startsWith(`${configName}/runs/`)).toEqual(true);

            const run = yield* bqdt.getProjectsLocationsTransferConfigsRuns({
              name: runName,
            });
            expect(run.name).toEqual(runName);
            expect(run.dataSourceId).toEqual("scheduled_query");
            expect(run.runTime).toEqual("2020-01-01T00:00:00Z");

            // Transfer configs have no resource-level IAM or IAM Conditions
            // support, so the binding documents a project grant.
            expect(yield* projectGrantsOf(hostAccount)).toEqual([
              { role: "roles/bigquery.admin", condition: undefined },
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigquerydatatransfer", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
