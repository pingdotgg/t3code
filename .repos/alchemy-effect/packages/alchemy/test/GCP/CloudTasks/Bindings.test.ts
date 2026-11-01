import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as cloudtasks from "@distilled.cloud/gcp/cloudtasks_v2";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import CloudTasksBindingsHost, {
  Jobs,
  TASK_URL,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CloudTasksBindings");

let baseUrl: string;
let queueName: string;
let hostAccount: string;

describe.skipIf(!dockerAvailable)(
  "CloudTasks Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:cloudtasks",
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
            const host = yield* CloudTasksBindingsHost;
            const queue = yield* Jobs;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              queue: queue.name,
            };
          }),
        );
        baseUrl = out.uri!;
        queueName = out.queue;
        hostAccount = out.serviceAccount!;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("CreateTask", () => {
      test.provider(
        "enqueues a task as the host's service account, granted on the queue only",
        (_stack) =>
          Effect.gen(function* () {
            const task = yield* expectProbe<cloudtasks.Task>(
              baseUrl,
              "createTask",
            );
            expect(task.name?.startsWith(`${queueName}/tasks/`)).toBe(true);
            expect(task.httpRequest?.url).toEqual(TASK_URL);

            const live = yield* cloudtasks.getProjectsLocationsQueuesTasks({
              name: task.name!,
            });
            expect(live.name).toEqual(task.name);
            expect(live.httpRequest?.url).toEqual(TASK_URL);
            expect(live.httpRequest?.httpMethod).toEqual("POST");

            const policy =
              yield* cloudtasks.getIamPolicyProjectsLocationsQueues({
                resource: queueName,
              });
            const roles = (policy.bindings ?? [])
              .filter((binding) =>
                (binding.members ?? []).includes(
                  `serviceAccount:${hostAccount}`,
                ),
              )
              .map((binding) => binding.role)
              .sort();
            expect(roles).toEqual(["roles/cloudtasks.enqueuer"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:cloudtasks", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
