import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as deploymentmanager from "@distilled.cloud/gcp/deploymentmanager_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (deployment: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      deploymentmanager.getDeployments({ project, deployment }),
    ),
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const target = {
  config: {
    content: `imports:
- path: topic.jinja
resources:
- name: topic
  type: topic.jinja
`,
  },
  imports: [
    {
      name: "topic.jinja",
      content: `resources:
- name: topic
  type: pubsub.v1.topic
  properties:
    topic: {{ env["deployment"] }}
`,
    },
  ],
};

test.provider(
  "getDeployments on a missing deployment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        deploymentmanager.getDeployments({
          project,
          deployment: "alchemy-missing-deployment",
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:deploymentmanager", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a deployment",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DeploymentManager.Deployment("App", {
            description: "alchemy dm test",
            labels: { env: "test" },
            target,
          });
        }),
      );

      expect(created.name).toEqual(expect.any(String));
      expect(created.deploymentId).toEqual(created.name);
      expect(created.project).toEqual(project);
      expect(created.description).toEqual("alchemy dm test");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.preview).toEqual(false);

      const fetched = yield* deploymentmanager.getDeployments({
        project,
        deployment: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      const fetchedLabels = Object.fromEntries(
        (fetched.labels ?? [])
          .filter(
            (entry): entry is { key: string; value: string } =>
              typeof entry.key === "string" && typeof entry.value === "string",
          )
          .map((entry) => [entry.key, entry.value]),
      );
      expect(fetchedLabels.env).toEqual("test");
      expect(fetchedLabels["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DeploymentManager.Deployment("App", {
            deploymentId: created.deploymentId,
            description: "alchemy dm test updated",
            labels: { env: "prod", role: "events" },
            target,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.deploymentId).toEqual(created.deploymentId);
      expect(updated.description).toEqual("alchemy dm test updated");
      expect(updated.labels).toMatchObject({ env: "prod", role: "events" });

      const fetchedUpdate = yield* deploymentmanager.getDeployments({
        project,
        deployment: created.name,
      });
      expect(fetchedUpdate.description).toEqual("alchemy dm test updated");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:deploymentmanager", "live"],
    timeout: 90_000,
  },
);
