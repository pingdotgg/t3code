import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { materializeIsolatedProject, removeIsolatedProject } from "../../IsolatedProject.ts";
import IsolatedProjectInstance, { project } from "./fixtures/isolated-project-instance.ts";
import { assertInstanceTerminated } from "./Gone.ts";
import * as Test from "./VpcTest.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Live proof that the EC2 hosted-program bootstrap boots when `main` lives
// in an isolated project (see test/IsolatedProject.ts) — the bundle `cwd`
// resolves none of alchemy's dependencies, so the bootstrap's
// `@distilled.cloud/aws/*` / `@effect/platform-bun` imports must be bundled
// by the virtual-entry plugin rather than found from the project root. With
// them left external bun dies at module load under systemd and the app port
// never answers.
//
// Heavy (instance boot + bun install + S3 sync + systemd, ~2 min), so
// skipped under --fast alongside the other isolated-project e2e tests.
test.provider.skipIf(!!process.env.FAST)(
  "instance program bundled from an isolated project serves HTTP",
  (stack) =>
    Effect.gen(function* () {
      yield* materializeIsolatedProject(project);
      yield* stack.destroy();

      try {
        const { instanceId, url } = yield* stack.deploy(
          Effect.gen(function* () {
            const instance = yield* IsolatedProjectInstance;
            return {
              instanceId: instance.instanceId,
              url: instance.url,
            };
          }),
        );
        expect(url).toBeTruthy();

        // Poll until the instance boots, installs bun, syncs the bundle from
        // S3, and the systemd unit serves 200 on :3000. Connection errors
        // before the server binds are normalised to "not ready".
        const base = url!;
        const served = yield* HttpClient.get(`${base}/health`).pipe(
          Effect.map((res) => res.status === 200),
          Effect.catch(() => Effect.succeed(false)),
          Effect.repeat({
            schedule: Schedule.spaced("8 seconds"),
            until: (ok) => ok,
            times: 75,
          }),
        );
        expect(served).toBe(true);

        yield* stack.destroy();
        yield* assertInstanceTerminated(instanceId);
      } finally {
        yield* removeIsolatedProject(project);
      }
    }),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 1_200_000 },
);
