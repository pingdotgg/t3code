import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as cloudbuild from "@distilled.cloud/gcp/cloudbuild_v2";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import CloudBuildBindingsHost, { Source } from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CloudBuildBindings");

// Needs a GitHub connection that has completed the OAuth handshake.
const runLifecycle =
  !!process.env.GCP_TEST_CLOUDBUILD_REPO && !process.env.FAST;

let baseUrl: string;
let hostAccount: string;
let repositoryName: string;

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
      }))
      .sort((left, right) => (left.role ?? "").localeCompare(right.role ?? ""));
  });

/** Cloud Build repository bindings grant on the project. */
const PROJECT_GRANTS = [
  { role: "roles/cloudbuild.connectionViewer", condition: undefined },
  { role: "roles/cloudbuild.readTokenAccessor", condition: undefined },
  { role: "roles/cloudbuild.tokenAccessor", condition: undefined },
];

const expectProjectGrants = Effect.gen(function* () {
  expect(yield* projectGrantsOf(hostAccount)).toEqual(PROJECT_GRANTS);
});

describe.skipIf(!dockerAvailable || !runLifecycle)(
  "CloudBuild Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:cloudbuild",
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
            const host = yield* CloudBuildBindingsHost;
            const repository = yield* Source;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              repository: repository.name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        repositoryName = out.repository;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("AccessReadToken", () => {
      test.provider(
        "mints a read token as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              token?: string;
              expirationTime?: string;
            }>(baseUrl, "accessReadToken");
            expect(out.token?.length ?? 0).toBeGreaterThan(0);
            expect(out.expirationTime).toEqual(expect.any(String));
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:cloudbuild", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("AccessReadWriteToken", () => {
      test.provider(
        "mints a read/write token as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              token?: string;
              expirationTime?: string;
            }>(baseUrl, "accessReadWriteToken");
            expect(out.token?.length ?? 0).toBeGreaterThan(0);
            expect(out.expirationTime).toEqual(expect.any(String));
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:cloudbuild", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("FetchGitRefs", () => {
      test.provider(
        "lists the repository's branches as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{ refNames?: string[] }>(
              baseUrl,
              "fetchGitRefs",
            );
            const expected =
              yield* cloudbuild.fetchGitRefsProjectsLocationsConnectionsRepositories(
                { repository: repositoryName, refType: "BRANCH" },
              );
            // Every repository has at least its default branch.
            expect(out.refNames?.length ?? 0).toBeGreaterThan(0);
            expect(out.refNames).toEqual(expected.refNames);
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:cloudbuild", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
