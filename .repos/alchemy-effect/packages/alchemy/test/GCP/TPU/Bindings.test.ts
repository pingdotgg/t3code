import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as tpu from "@distilled.cloud/gcp/tpu_v2";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import TpuBindingsHost, {
  QueuedTrainer,
  Trainer,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "TpuBindings");

// Cloud TPU is disabled on the testing project (ServiceDisabled "Cloud TPU API
// has not been used in project ...") and TPU VMs bill by the hour (dollars
// per run) and need TPU quota; set GCP_TEST_TPU=1 to opt in.
const runLifecycle = !!process.env.GCP_TEST_TPU && !process.env.FAST;

let baseUrl: string;
let hostAccount: string;
let project: string;
let nodeName: string;
let queuedResourceName: string;

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

describe.skipIf(!dockerAvailable || !runLifecycle)(
  "TPU Bindings",
  { tags: ["provider:gcp", "provider:gcp:tpu", "provider:gcp:run", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* TpuBindingsHost;
            const node = yield* Trainer;
            const queued = yield* QueuedTrainer;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              project: host.project,
              node: node.name,
              queued: queued.name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        project = out.project;
        nodeName = out.node;
        queuedResourceName = out.queued;
      }),
      { timeout: 1_800_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 1_200_000 });

    // Cloud TPU has no resource-level IAM: both bindings grant tpu.viewer
    // on the project.
    const expectTpuViewerOnly = Effect.gen(function* () {
      expect(yield* projectRoles()).toEqual([
        { role: "roles/tpu.viewer", condition: undefined },
      ]);
    });

    describe("GetNode", () => {
      test.provider(
        "reads the bound node as the host",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              name: string;
              acceleratorType: string;
            }>(baseUrl, "getNode");
            const live = yield* tpu.getProjectsLocationsNodes({
              name: nodeName,
            });
            expect(out.name).toEqual(live.name);
            expect(out.acceleratorType).toEqual("v2-8");
            yield* expectTpuViewerOnly;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:tpu", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetQueuedResource", () => {
      test.provider(
        "reads the bound queued resource as the host",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{ name: string }>(
              baseUrl,
              "getQueuedResource",
            );
            const live = yield* tpu.getProjectsLocationsQueuedResources({
              name: queuedResourceName,
            });
            expect(out.name).toEqual(live.name);
            yield* expectTpuViewerOnly;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:tpu", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
