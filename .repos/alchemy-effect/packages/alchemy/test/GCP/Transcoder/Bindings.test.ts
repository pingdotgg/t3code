import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as transcoder from "@distilled.cloud/gcp/transcoder_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import TranscoderBindingsHost from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "TranscoderBindings");

let baseUrl: string;
let hostAccount: string;
let project: string;

/** Project-level roles held by the host's service account. */
const projectRoles = () =>
  resourcemanager
    .getIamPolicyProjects({
      resource: `projects/${project}`,
      body: { options: { requestedPolicyVersion: 3 } },
    })
    .pipe(
      Effect.map((policy) =>
        (policy.bindings ?? [])
          .filter((binding) =>
            (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
          )
          .map((binding) => ({
            role: binding.role,
            condition: binding.condition?.expression,
          })),
      ),
    );

const waitUntilJobGone = (name: string) =>
  transcoder.getProjectsLocationsJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

describe.skipIf(!dockerAvailable || !!process.env.FAST)(
  "Transcoder Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:transcoder",
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
            const host = yield* TranscoderBindingsHost;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              project: host.project,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        project = out.project;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("CreateJob", () => {
      test.provider(
        "starts a job from the bound template as the host, with transcoder.editor on the project",
        (_stack) =>
          Effect.gen(function* () {
            const started = yield* expectProbe<{
              name: string;
              muxStreams: string[];
            }>(baseUrl, "createJob");
            const live = yield* transcoder.getProjectsLocationsJobs({
              name: started.name,
            });
            // The job is not stack-managed: remove it before asserting.
            yield* transcoder.deleteProjectsLocationsJobs({
              name: started.name,
              allowMissing: true,
            });
            const gone = yield* waitUntilJobGone(started.name);

            expect(started.name).toMatch(
              /^projects\/[^/]+\/locations\/us-central1\/jobs\/[^/]+$/,
            );
            // The job runs the bound template's config.
            expect(started.muxStreams).toEqual(["sd"]);
            expect(live.name).toEqual(started.name);
            expect(
              (live.config?.muxStreams ?? []).map((stream) => stream.key),
            ).toEqual(["sd"]);
            expect(gone).toEqual("gone");

            // No resource-level IAM and no narrower role with jobs.create.
            expect(yield* projectRoles()).toEqual([
              { role: "roles/transcoder.editor", condition: undefined },
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:transcoder", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
