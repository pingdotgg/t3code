import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as apprunner from "@distilled.cloud/aws/apprunner";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  materializeIsolatedProject,
  removeIsolatedProject,
} from "../../IsolatedProject.ts";
import IsolatedProjectService, {
  project,
} from "./fixtures/isolated-project-service.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Live proof that the App Runner bun bootstrap boots when the service's
// `main` lives in an isolated project (see test/IsolatedProject.ts) — the
// bundle `cwd` resolves none of alchemy's dependencies, so the bootstrap's
// `@distilled.cloud/aws/*` / `@effect/platform-bun` imports must be bundled
// by the virtual-entry plugin rather than found from the project root. With
// them left external the container dies at module load, the health check
// never passes, and the service never reaches RUNNING.
//
// Heavy (Docker build + ECR push + 3-5 min App Runner provisioning, bills
// while running), so gated behind AWS_TEST_SLOW=1 like the platform e2e.
test.provider.skipIf(!process.env.AWS_TEST_SLOW || !!process.env.FAST)(
  "service bundled from an isolated project boots and serves HTTP",
  (stack) =>
    Effect.gen(function* () {
      yield* materializeIsolatedProject(project);
      yield* stack.destroy();

      try {
        const service = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* IsolatedProjectService;
          }),
        );
        expect(service.status).toBe("RUNNING");
        expect(service.serviceUrl).toBeTruthy();

        const health = yield* HttpClient.get(
          `https://${service.serviceUrl}/health`,
        ).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json
              : Effect.fail(new Error(`/health returned ${res.status}`)),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.fixed("3 seconds"),
              Schedule.recurs(20),
            ]),
          }),
        );
        expect(health).toEqual({ ok: true });

        // Destroy immediately — App Runner services bill while running.
        const { serviceArn } = service;
        yield* stack.destroy();
        const after = yield* apprunner
          .describeService({ ServiceArn: serviceArn })
          .pipe(
            Effect.map((r) => (r.Service.Status ?? "UNKNOWN").toUpperCase()),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed("GONE" as const),
            ),
          );
        expect(["GONE", "DELETED"]).toContain(after);
      } finally {
        yield* removeIsolatedProject(project);
      }
    }),
  // Docker build + push (~2-4 min) + create (~3-5 min) + delete (~2-3 min).
  { timeout: 1_200_000 },
);
