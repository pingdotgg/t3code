import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import RunBindingsHost, {
  Api,
  Callee,
  Migrate,
  Workers,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RunBindings");

let baseUrl: string;
let member: string;
let names: {
  api: string;
  callee: string;
  calleeUri: string;
  workers: string;
  job: string;
};

type Policy = { bindings?: { role?: string; members?: string[] }[] };

const rolesOf = (policy: Policy) =>
  (policy.bindings ?? [])
    .filter((binding) => (binding.members ?? []).includes(member))
    .map((binding) => binding.role)
    .sort();

const serviceRoles = (name: string) =>
  cloudrun
    .getIamPolicyProjectsLocationsServices({
      resource: name,
      "options.requestedPolicyVersion": 3,
    })
    .pipe(Effect.map(rolesOf));

describe.skipIf(!dockerAvailable)(
  "Run Bindings",
  { tags: ["provider:gcp", "provider:gcp:run", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* RunBindingsHost;
            const callee = yield* Callee;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              api: (yield* Api).name,
              callee: callee.name,
              calleeUri: callee.uri,
              workers: (yield* Workers).name,
              job: (yield* Migrate).name,
            };
          }),
        );
        baseUrl = out.uri!;
        member = `serviceAccount:${out.serviceAccount!}`;
        names = { ...out, calleeUri: out.calleeUri! };
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("GetService", () => {
      test.provider(
        "reads the service, granted viewer on the service only",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<cloudrun.GoogleCloudRunV2Service>(
              baseUrl,
              "getService",
            );
            expect(live.name).toEqual(names.api);
            expect(live.template?.containers?.[0]?.image).toEqual(
              "us-docker.pkg.dev/cloudrun/container/hello",
            );
            expect(yield* serviceRoles(names.api)).toEqual([
              "roles/run.viewer",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:run", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetWorkerPool", () => {
      test.provider(
        "reads the worker pool, granted viewer on the pool only",
        (_stack) =>
          Effect.gen(function* () {
            const live =
              yield* expectProbe<cloudrun.GoogleCloudRunV2WorkerPool>(
                baseUrl,
                "getWorkerPool",
              );
            expect(live.name).toEqual(names.workers);

            const policy =
              yield* cloudrun.getIamPolicyProjectsLocationsWorkerPools({
                resource: names.workers,
                "options.requestedPolicyVersion": 3,
              });
            expect(rolesOf(policy)).toEqual(["roles/run.viewer"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:run", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("RunJob", () => {
      test.provider(
        "starts an execution, granted jobsExecutorWithOverrides on the job only",
        (_stack) =>
          Effect.gen(function* () {
            const operation =
              yield* expectProbe<cloudrun.GoogleLongrunningOperation>(
                baseUrl,
                "runJob",
              );
            const executionName = operation.metadata?.name;
            expect(typeof executionName).toEqual("string");
            expect(String(executionName)).toContain(`${names.job}/executions/`);

            // Out of band: the execution exists under the bound job.
            const execution =
              yield* cloudrun.getProjectsLocationsJobsExecutions({
                name: String(executionName),
              });
            expect(execution.name).toEqual(executionName);

            const policy = yield* cloudrun.getIamPolicyProjectsLocationsJobs({
              resource: names.job,
              "options.requestedPolicyVersion": 3,
            });
            expect(rolesOf(policy)).toEqual([
              "roles/run.jobsExecutorWithOverrides",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:run", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("InvokeService", () => {
      test.provider(
        "calls the private service with an ID token, granted invoker on it only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{ status: number; text: string }>(
              baseUrl,
              "invokeService",
            );
            expect(out.status).toEqual(200);
            expect(out.text).toContain("It's running!");

            // Without a token Cloud Run rejects the call at its front end.
            const direct = yield* HttpClient.get(names.calleeUri);
            expect(direct.status).toEqual(403);

            expect(yield* serviceRoles(names.callee)).toEqual([
              "roles/run.invoker",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:run", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
