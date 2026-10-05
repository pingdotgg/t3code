import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as workstations from "@distilled.cloud/gcp/workstations_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import WorkstationsBindingsHost, { Dev } from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "WorkstationsBindings");

// Workstation clusters take ~20 minutes to create and delete.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

let baseUrl: string;
let hostAccount: string;
let project: string;
let clusterName: string;
let configName: string;
let workstationName: string;

const member = () => `serviceAccount:${hostAccount}`;

const rolesIn = (
  bindings: ReadonlyArray<{ role?: string; members?: ReadonlyArray<string> }>,
) =>
  bindings
    .filter((binding) => (binding.members ?? []).includes(member()))
    .map((binding) => binding.role)
    .sort();

/** Project-level roles (with their IAM Condition) held by the host. */
const projectRoles = () =>
  resourcemanager
    .getIamPolicyProjects({
      resource: `projects/${project}`,
      body: { options: { requestedPolicyVersion: 3 } },
    })
    .pipe(
      Effect.map((policy) =>
        (policy.bindings ?? [])
          .filter((binding) => (binding.members ?? []).includes(member()))
          .map((binding) => ({
            role: binding.role,
            condition: binding.condition?.expression,
          })),
      ),
    );

const configRoles = () =>
  workstations
    .getIamPolicyProjectsLocationsWorkstationClustersWorkstationConfigs({
      resource: configName,
    })
    .pipe(Effect.map((policy) => rolesIn(policy.bindings ?? [])));

const workstationRoles = () =>
  workstations
    .getIamPolicyProjectsLocationsWorkstationClustersWorkstationConfigsWorkstations(
      { resource: workstationName },
    )
    .pipe(Effect.map((policy) => rolesIn(policy.bindings ?? [])));

const waitForState = (state: string) =>
  workstations
    .getProjectsLocationsWorkstationClustersWorkstationConfigsWorkstations({
      name: workstationName,
    })
    .pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (live) => live.state === state,
        times: 48,
      }),
    );

describe.skipIf(!dockerAvailable || !runLifecycle)(
  "Workstations Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:workstations",
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
            const host = yield* WorkstationsBindingsHost;
            const { cluster, config, workstation } = yield* Dev;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              project: host.project,
              cluster: cluster.name,
              config: config.name,
              workstation: workstation.name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        project = out.project;
        clusterName = out.cluster;
        configName = out.config;
        workstationName = out.workstation;
      }),
      { timeout: 3_000_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 3_000_000 });

    describe("GetWorkstationCluster", () => {
      test.provider(
        "reads the bound cluster as the host, with workstations.viewer on the project",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{ name: string; network: string }>(
              baseUrl,
              "getWorkstationCluster",
            );
            expect(out.name).toEqual(clusterName);
            expect(out.network).toContain("/networks/default");
            // Clusters have no IAM policy of their own.
            expect(yield* projectRoles()).toEqual([
              { role: "roles/workstations.viewer", condition: undefined },
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:workstations", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetWorkstationConfig", () => {
      test.provider(
        "reads the bound config as the host, with workstations.viewer on the config only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              name: string;
              machineType: string;
            }>(baseUrl, "getWorkstationConfig");
            expect(out.name).toEqual(configName);
            expect(out.machineType).toEqual("e2-standard-2");
            expect(yield* configRoles()).toEqual(["roles/workstations.viewer"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:workstations", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetWorkstation", () => {
      test.provider(
        "reads the bound workstation as the host, with workstations.viewer on it",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{ name: string; state: string }>(
              baseUrl,
              "getWorkstation",
            );
            expect(out.name).toEqual(workstationName);
            expect(out.state).toEqual("STATE_STOPPED");
            expect(yield* workstationRoles()).toContain(
              "roles/workstations.viewer",
            );
          }),
        {
          tags: ["provider:gcp", "provider:gcp:workstations", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("StartWorkstation", () => {
      test.provider(
        "starts the bound workstation as the host",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{ name: string }>(
              baseUrl,
              "startWorkstation",
            );
            expect(out.name).toContain("/operations/");
            const live = yield* waitForState("STATE_RUNNING");
            expect(live.state).toEqual("STATE_RUNNING");
            expect(yield* workstationRoles()).toContain(
              "roles/workstations.user",
            );
          }),
        {
          tags: ["provider:gcp", "provider:gcp:workstations", "live"],
          timeout: 900_000,
        },
      );
    });

    describe("GenerateAccessToken", () => {
      test.provider(
        "mints an access token for the bound workstation as the host",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              hasToken: boolean;
              expireTime: string;
            }>(baseUrl, "generateAccessToken");
            expect(out.hasToken).toEqual(true);
            expect(Date.parse(out.expireTime)).toBeGreaterThan(
              Date.parse("2026-01-01T00:00:00Z"),
            );
            expect(yield* workstationRoles()).toContain(
              "roles/workstations.user",
            );
          }),
        {
          tags: ["provider:gcp", "provider:gcp:workstations", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("StopWorkstation", () => {
      test.provider(
        "stops the bound workstation as the host; the host holds only user and viewer on it",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{ name: string }>(
              baseUrl,
              "stopWorkstation",
            );
            expect(out.name).toContain("/operations/");
            const live = yield* waitForState("STATE_STOPPED");
            expect(live.state).toEqual("STATE_STOPPED");
            expect(yield* workstationRoles()).toEqual([
              "roles/workstations.user",
              "roles/workstations.viewer",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:workstations", "live"],
          timeout: 900_000,
        },
      );
    });
  },
);
