import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as codebuild from "@distilled.cloud/aws/codebuild";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import CodeBuildTestFunctionLive, {
  CodeBuildTestFunction,
  FIXTURE_PROJECT_NAME,
  FIXTURE_REPORT_GROUP_NAME,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CodeBuildBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx from the shared Lambda fixture (cold re-init, IAM
// propagation on the freshly attached codebuild policy surfaced as a 500 by
// the handler's `Effect.orDie`). Genuine 4xx/assertion failures return
// immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

const getJson = (url: string) =>
  send(HttpClientRequest.get(url)).pipe(Effect.flatMap((r) => r.json));

const postJson = (url: string, body: unknown) =>
  send(
    HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
  ).pipe(Effect.flatMap((r) => r.json));

const post = (url: string) =>
  send(HttpClientRequest.post(url)).pipe(Effect.flatMap((r) => r.json));

/**
 * A route answered with a typed error tag. The tag being present proves the
 * binding produced a typed failure (untyped errors crash into a 500), and it
 * not being an authorization tag proves the IAM grant covered the call.
 */
const expectTypedNonAuthz = (body: any) => {
  expect(typeof body.errorTag).toBe("string");
  expect(body.errorTag).not.toBe("AccessDeniedException");
};

/** A route that either succeeded or failed with a typed, authorized tag. */
const expectAuthorized = (body: any) => {
  if (body.errorTag !== undefined) expectTypedNonAuthz(body);
};

class BuildNotTerminal extends Data.TaggedError("BuildNotTerminal") {}

/** Poll a build until it leaves IN_PROGRESS (bounded). */
const waitForTerminal = (buildId: string) =>
  getJson(`${baseUrl}/build/get?id=${encodeURIComponent(buildId)}`).pipe(
    Effect.flatMap((body: any) =>
      body.status === undefined || body.status === "IN_PROGRESS"
        ? Effect.fail(new BuildNotTerminal())
        : Effect.succeed(body.status as string),
    ),
    Effect.retry({
      while: (e): boolean => e._tag === "BuildNotTerminal",
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );

const FAKE_UUID = "00000000-0000-0000-0000-000000000000";

describe.sequential("CodeBuild Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("CodeBuild test setup: destroying previous");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("CodeBuild test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* CodeBuildTestFunction;
        }).pipe(Effect.provide(CodeBuildTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/build/list`;

      yield* Effect.logInfo(
        `CodeBuild test setup: probing readiness at ${readinessUrl}`,
      );
      // Ready = the function answers 200 AND the freshly attached codebuild
      // policy has propagated (an AccessDeniedException errorTag means IAM
      // is still converging — keep probing).
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.json
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.flatMap((body: any) =>
          body.errorTag === undefined
            ? Effect.succeed(body)
            : Effect.fail(new Error(`IAM not propagated: ${body.errorTag}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 240_000,
  });

  describe("StartBuild + ListBuildsForProject + BatchGetBuilds + StopBuild + RetryBuild + BatchDeleteBuilds", () => {
    test.provider(
      "starts a build, observes it, stops it, retries it",
      (_stack) =>
        Effect.gen(function* () {
          // StartBuild
          const started = (yield* post(`${baseUrl}/build/start`)) as any;
          expect(started.errorTag).toBeUndefined();
          expect(started.buildId).toContain(FIXTURE_PROJECT_NAME);
          const buildId = started.buildId as string;

          // ListBuildsForProject sees it
          const listed = (yield* getJson(`${baseUrl}/build/list`)) as any;
          expect(listed.ids).toContain(buildId);

          // StopBuild — a just-started build is stoppable in any
          // pre-terminal phase.
          const stopped = (yield* postJson(`${baseUrl}/build/stop`, {
            id: buildId,
          })) as any;
          expectAuthorized(stopped);

          // BatchGetBuilds — poll to a terminal status (bounded).
          const terminal = yield* waitForTerminal(buildId);
          expect(["STOPPED", "SUCCEEDED", "FAILED", "STOPPING"]).toContain(
            terminal,
          );

          // RetryBuild — restarts the finished build (typed error is
          // acceptable if the build is still finalizing).
          const retried = (yield* postJson(`${baseUrl}/build/retry`, {
            id: buildId,
          })) as any;
          expectAuthorized(retried);
          if (retried.buildId !== undefined) {
            // Don't leave the retried build running.
            const restopped = (yield* postJson(`${baseUrl}/build/stop`, {
              id: retried.buildId,
            })) as any;
            expectAuthorized(restopped);
          }

          // BatchDeleteBuilds — regular builds are typically reported in
          // `buildsNotDeleted` (only batch-build members are deletable);
          // the call completing proves the IAM + binding wiring.
          const deleted = (yield* postJson(`${baseUrl}/build/delete`, {
            ids: [buildId],
          })) as any;
          expectAuthorized(deleted);
        }),
      { timeout: 240_000 },
    );
  });

  describe("InvalidateProjectCache", () => {
    test.provider("invalidates the project's build cache", (_stack) =>
      Effect.gen(function* () {
        // The fixture project has no cache configured — success and a typed
        // rejection both prove the wiring.
        const body = (yield* post(`${baseUrl}/cache/invalidate`)) as any;
        expectAuthorized(body);
      }),
    );
  });

  describe("Batch builds", () => {
    test.provider(
      "StartBuildBatch rejects a project without batch config (typed)",
      (_stack) =>
        Effect.gen(function* () {
          const body = (yield* post(`${baseUrl}/batch/start`)) as any;
          // The fixture project has no build-batch configuration —
          // CodeBuild must reject with the TYPED InvalidInputException.
          expect(body.errorTag).toBe("InvalidInputException");
        }),
    );

    test.provider("ListBuildBatchesForProject lists (empty)", (_stack) =>
      Effect.gen(function* () {
        const body = (yield* getJson(`${baseUrl}/batch/list`)) as any;
        expect(body.errorTag).toBeUndefined();
        expect(body.ids).toEqual([]);
      }),
    );

    test.provider("BatchGetBuildBatches reports unknown ids", (_stack) =>
      Effect.gen(function* () {
        const fakeId = `${FIXTURE_PROJECT_NAME}:${FAKE_UUID}`;
        const body = (yield* getJson(
          `${baseUrl}/batch/get?id=${encodeURIComponent(fakeId)}`,
        )) as any;
        expect(body.errorTag).toBeUndefined();
        // The unknown id is reported back (in `buildBatchesNotFound`) rather
        // than yielding a batch.
        expect(body.found).toEqual([]);
        expect(JSON.stringify(body)).toContain(FAKE_UUID);
      }),
    );

    test.provider(
      "Stop/Retry/DeleteBuildBatch answer typed for unknown ids",
      (_stack) =>
        Effect.gen(function* () {
          const fakeId = `${FIXTURE_PROJECT_NAME}:${FAKE_UUID}`;
          const stopped = (yield* postJson(`${baseUrl}/batch/stop`, {
            id: fakeId,
          })) as any;
          expectTypedNonAuthz(stopped);

          const retried = (yield* postJson(`${baseUrl}/batch/retry`, {
            id: fakeId,
          })) as any;
          expectTypedNonAuthz(retried);

          const deleted = (yield* postJson(`${baseUrl}/batch/delete`, {
            id: fakeId,
          })) as any;
          expectAuthorized(deleted);
        }),
    );
  });

  describe("Sandboxes", () => {
    test.provider(
      "StartSandbox + BatchGetSandboxes + ListSandboxesForProject + StopSandbox",
      (_stack) =>
        Effect.gen(function* () {
          const started = (yield* post(`${baseUrl}/sandbox/start`)) as any;
          expectAuthorized(started);

          if (started.sandboxId !== undefined) {
            // Stop it right away — sandboxes bill while running.
            const stopped = (yield* postJson(`${baseUrl}/sandbox/stop`, {
              id: started.sandboxId,
            })) as any;
            expectAuthorized(stopped);

            const got = (yield* getJson(
              `${baseUrl}/sandbox/get?id=${encodeURIComponent(started.sandboxId)}`,
            )) as any;
            expectAuthorized(got);

            const listed = (yield* getJson(`${baseUrl}/sandbox/list`)) as any;
            expect(listed.errorTag).toBeUndefined();
            expect(listed.ids).toContain(started.sandboxId);
          } else {
            // Sandboxes are not available for every project configuration —
            // the typed rejection still proves IAM + binding wiring.
            const listed = (yield* getJson(`${baseUrl}/sandbox/list`)) as any;
            expectAuthorized(listed);
          }
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "command-execution bindings answer typed for an unknown sandbox",
      (_stack) =>
        Effect.gen(function* () {
          const fakeSandbox = `${FIXTURE_PROJECT_NAME}:${FAKE_UUID}`;
          const command = (yield* postJson(`${baseUrl}/sandbox/command`, {
            sandboxId: fakeSandbox,
            command: "echo hello",
          })) as any;
          expectTypedNonAuthz(command);

          const got = (yield* getJson(
            `${baseUrl}/sandbox/command-get?sandboxId=${encodeURIComponent(fakeSandbox)}&commandId=${FAKE_UUID}`,
          )) as any;
          expectAuthorized(got);

          const listed = (yield* getJson(
            `${baseUrl}/sandbox/commands?sandboxId=${encodeURIComponent(fakeSandbox)}`,
          )) as any;
          expectAuthorized(listed);
        }),
    );
  });

  describe("Reports", () => {
    test.provider(
      "report-read bindings are wired against the bound group",
      (_stack) =>
        Effect.gen(function* () {
          // The fixture group is fresh — no reports yet.
          const listed = (yield* getJson(`${baseUrl}/reports/list`)) as any;
          expect(listed.errorTag).toBeUndefined();
          expect(listed.reports).toEqual([]);

          // Fabricate a report ARN inside the bound group (IAM authorizes
          // report reads against the report-group ARN).
          const groupArn = yield* codebuild
            .listReportGroups({})
            .pipe(
              Effect.map((res) =>
                res.reportGroups?.find((arn) =>
                  arn.endsWith(`report-group/${FIXTURE_REPORT_GROUP_NAME}`),
                ),
              ),
            );
          expect(groupArn).toBeDefined();
          const fakeReportArn = `${groupArn!.replace(
            ":report-group/",
            ":report/",
          )}:${FAKE_UUID}`;

          const got = (yield* getJson(
            `${baseUrl}/reports/get?arn=${encodeURIComponent(fakeReportArn)}`,
          )) as any;
          expectAuthorized(got);
          if (got.errorTag === undefined) {
            expect(got.notFound).toContain(fakeReportArn);
          }

          const testCases = (yield* getJson(
            `${baseUrl}/reports/test-cases?arn=${encodeURIComponent(fakeReportArn)}`,
          )) as any;
          expectAuthorized(testCases);

          const coverage = (yield* getJson(
            `${baseUrl}/reports/coverage?arn=${encodeURIComponent(fakeReportArn)}`,
          )) as any;
          expectAuthorized(coverage);

          const trend = (yield* getJson(`${baseUrl}/reports/trend`)) as any;
          expectAuthorized(trend);

          const deleted = (yield* postJson(`${baseUrl}/reports/delete`, {
            arn: fakeReportArn,
          })) as any;
          expectAuthorized(deleted);
        }),
      { timeout: 120_000 },
    );
  });
});
