import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import ArtifactRegistryBindingsHost, {
  Images,
} from "./fixtures/bindings-host.ts";
import { IMAGE, pushDockerVersion } from "./registry.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ArtifactRegistryBindings");

let baseUrl: string;
let hostAccount: string;
let repository: {
  name: string;
  repositoryId: string;
  project: string;
  location: string;
};

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
  "ArtifactRegistry Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:artifactregistry",
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
            const host = yield* ArtifactRegistryBindingsHost;
            const images = yield* Images;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              repository: {
                name: images.name,
                repositoryId: images.repositoryId,
                project: images.project,
                location: images.location,
              },
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        repository = out.repository;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("ListDockerImages", () => {
      test.provider(
        "lists a pushed image as the host's service account, granted on the repository only",
        (_stack) =>
          Effect.gen(function* () {
            const version = yield* pushDockerVersion(repository, "v1");
            const digest = version.split("/versions/")[1]!;

            const page = yield* expectProbe<{
              dockerImages?: Array<{ name?: string; uri?: string }>;
            }>(baseUrl, "listDockerImages").pipe(
              // The pushed image is listed once the registry indexes it.
              Effect.repeat({
                schedule: Schedule.spaced("3 seconds"),
                until: (result) => (result.dockerImages ?? []).length > 0,
                times: 10,
              }),
            );
            expect((page.dockerImages ?? []).map((image) => image.uri)).toEqual(
              [
                `${repository.location}-docker.pkg.dev/${repository.project}/${repository.repositoryId}/${IMAGE}@${digest}`,
              ],
            );

            const policy =
              yield* artifactregistry.getIamPolicyProjectsLocationsRepositories(
                {
                  resource: repository.name,
                  "options.requestedPolicyVersion": 3,
                },
              );
            const roles = (policy.bindings ?? [])
              .filter((binding) =>
                (binding.members ?? []).includes(
                  `serviceAccount:${hostAccount}`,
                ),
              )
              .map((binding) => binding.role);
            expect(roles).toEqual(["roles/artifactregistry.reader"]);
            expect(yield* projectGrantsOf(hostAccount)).toEqual([]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:artifactregistry", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
