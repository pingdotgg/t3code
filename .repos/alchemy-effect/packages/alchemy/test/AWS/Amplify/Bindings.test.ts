import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as amplify from "@distilled.cloud/aws/amplify";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import AmplifyTestFunctionLive, {
  AmplifyTestFunction,
} from "./fixtures/handler";
import { makeAmplifyTestLease } from "./TestLease.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AmplifyBindings");
const testLease = makeAmplifyTestLease();

beforeAll(testLease.acquire, { timeout: 240_000 });
afterAll(testLease.release);

const branchName = "main";

// Minimal deployable site: a stored zip containing a single `index.html`
// ("hello amplify"). Generated once and checked in as a constant so the test
// never zips at runtime.
const SITE_ZIP_BASE64 =
  "UEsDBBQAAAAAAAAAIVwZ1jYHJwAAACcAAAAKAAAAaW5kZXguaHRtbDxodG1sPjxib2R5PmhlbGxvIGFtcGxpZnk8L2JvZHk+PC9odG1sPlBLAQIUAxQAAAAAAAAAIVwZ1jYHJwAAACcAAAAKAAAAAAAAAAAAAACAAQAAAABpbmRleC5odG1sUEsFBgAAAAABAAEAOAAAAE8AAAAAAA==";

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(10),
]);

let baseUrl: string;
let appId: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

// Retry transient 5xx from the fixture (cold re-init under parallel-suite
// load); genuine 4xx surfaces immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({
                  status: response.status,
                  body,
                  message: `fixture returned ${response.status}: ${body}`,
                }),
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

const postJson = (path: string, body: unknown) =>
  send(
    HttpClientRequest.post(`${baseUrl}${path}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
    ),
  ).pipe(Effect.flatMap((response) => response.json));

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((response) => response.json),
  );

const deploySite = (branchName: string) =>
  Effect.gen(function* () {
    const staged = (yield* postJson("/deployments", { branchName })) as {
      jobId: string;
      zipUploadUrl: string;
    };
    expect(staged.jobId).toBeTruthy();
    expect(staged.zipUploadUrl).toContain("https://");

    const zipBytes = yield* Effect.sync(() =>
      Uint8Array.from(Buffer.from(SITE_ZIP_BASE64, "base64")),
    );
    const upload = yield* HttpClient.execute(
      HttpClientRequest.put(staged.zipUploadUrl).pipe(
        HttpClientRequest.bodyUint8Array(zipBytes, "application/zip"),
      ),
    );
    expect(upload.status).toBe(200);

    const released = (yield* postJson("/deployments/start", {
      branchName,
      jobId: staged.jobId,
    })) as { jobSummary: { jobId: string; status: string } };
    expect(released.jobSummary.jobId).toBe(staged.jobId);

    const settled = yield* getJson(
      `/job?branchName=${branchName}&jobId=${staged.jobId}`,
    ).pipe(
      Effect.map((body) => body as { status: string; stepCount: number }),
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (job): boolean =>
          job.status === "SUCCEED" ||
          job.status === "FAILED" ||
          job.status === "CANCELLED",
        times: 10,
      }),
    );
    expect(settled.status).toBe("SUCCEED");

    return { ...staged, ...settled };
  });

describe.sequential("Amplify Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();

      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* AmplifyTestFunction;
        }).pipe(Effect.provide(AmplifyTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      yield* HttpClient.get(`${baseUrl}/ping`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );

      const meta = (yield* getJson("/meta")) as { appId: string };
      appId = meta.appId;
      expect(appId).toBeTruthy();

      // Manual-deploy branch (no repo needed) for the deployment bindings.
      // The fixture app is freshly created above, so the branch never
      // pre-exists; app deletion on destroy removes it.
      // `beforeAll` doesn't run inside `test.provider`'s environment, so
      // provide the AWS providers (Credentials/Region) explicitly for the
      // out-of-band distilled call.
      yield* Core.withProviders(
        amplify.createBranch({
          appId,
          branchName,
          enableAutoBuild: false,
        }),
        testOptions,
        "AmplifyBindings",
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  test(
    "manual deployment lifecycle through the bindings",
    Effect.gen(function* () {
      // CreateDeployment, StartDeployment, and GetJob — stage the site,
      // upload it through the pre-signed URL, release it, and wait for the
      // deployment to settle.
      const deployed = yield* deploySite(branchName);

      // ListJobs — the deployment shows up in the branch's job history.
      const jobs = (yield* getJson(`/jobs?branchName=${branchName}`)) as {
        jobSummaries: Array<{ jobId: string }>;
      };
      expect(jobs.jobSummaries.map((j) => j.jobId)).toContain(deployed.jobId);

      // ListArtifacts — manual deploys typically produce none; the call
      // itself (auth + wiring) is what's under test.
      const artifacts = (yield* getJson(
        `/artifacts?branchName=${branchName}&jobId=${deployed.jobId}`,
      )) as {
        artifacts: Array<{ artifactId: string; artifactFileName: string }>;
      };
      expect(Array.isArray(artifacts.artifacts)).toBe(true);

      // GetArtifactUrl — only exercisable when the job produced artifacts.
      if (artifacts.artifacts.length > 0) {
        const artifactUrl = (yield* getJson(
          `/artifact-url?artifactId=${artifacts.artifacts[0].artifactId}`,
        )) as { artifactUrl: string };
        expect(artifactUrl.artifactUrl).toContain("https://");
      }

      // StopJob — the job already settled, so the service rejects the stop
      // with a typed tag; either outcome proves the binding + IAM wiring.
      const stopped = (yield* postJson("/jobs/stop", {
        branchName,
        jobId: deployed.jobId,
      })) as { stopped: boolean; errorTag?: string };
      if (!stopped.stopped) {
        expect(stopped.errorTag).toBe("BadRequestException");
      }

      // DeleteJob correctly rejects the active hosted deployment with a typed
      // BadRequestException. Deploy a successor, then prune the old job.
      const activeDelete = (yield* postJson("/jobs/delete", {
        branchName,
        jobId: deployed.jobId,
      })) as { deleted: boolean; errorTag?: string; message?: string };
      expect(activeDelete.deleted).toBe(false);
      expect(activeDelete.errorTag).toBe("BadRequestException");
      expect(activeDelete.message).toContain("active job");

      const successor = yield* deploySite(branchName);
      expect(successor.jobId).not.toBe(deployed.jobId);

      // Amplify marks the superseded job deletable eventually — the successor
      // can settle while the old job still reads "active" for a beat, so
      // retry the delete until it lands (bounded).
      const deleted = (yield* postJson("/jobs/delete", {
        branchName,
        jobId: deployed.jobId,
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (r) => (r as { deleted: boolean }).deleted,
          times: 10,
        }),
      )) as { deleted: boolean; errorTag?: string };
      expect(deleted.deleted).toBe(true);

      // Out-of-band: the job is gone from the branch history.
      const remaining = yield* Core.withProviders(
        amplify.listJobs({ appId, branchName }),
        testOptions,
        "AmplifyBindings",
      );
      expect(remaining.jobSummaries.map((j) => j.jobId)).not.toContain(
        deployed.jobId,
      );
    }),
    { timeout: 120_000, retry: 0 },
  );

  test(
    "startJob surfaces the typed rejection for a repo-less branch",
    Effect.gen(function* () {
      // RELEASE jobs need a connected Git repository; a manual-deploy branch
      // rejects them with BadRequestException. Reaching that typed tag proves
      // the binding executed against the service with the granted IAM.
      const result = (yield* postJson("/jobs/start", {
        branchName,
        jobType: "RELEASE",
      })) as { started: boolean; errorTag?: string };
      expect(result.started).toBe(false);
      expect(result.errorTag).toBe("BadRequestException");
    }),
    { timeout: 60_000 },
  );

  test(
    "consumeDeploymentStatusChanges creates the EventBridge subscription",
    Effect.gen(function* () {
      // Deploy-time proof: the event source registered a rule on the default
      // bus matching Amplify deployment status changes. (Actual delivery is
      // recorded best-effort on the /events route — a different Lambda
      // instance may serve it, so delivery is not hard-asserted here.)
      const rules = yield* Core.withProviders(
        eventbridge
          .listRules({ NamePrefix: "AmplifyBindings" })
          .pipe(Effect.map((page) => page.Rules ?? [])),
        testOptions,
        "AmplifyBindings",
      );
      const rule = rules.find(
        (r): boolean =>
          typeof r.EventPattern === "string" &&
          r.EventPattern.includes('"aws.amplify"'),
      );
      expect(rule).toBeDefined();
      expect(rule!.EventPattern).toContain("Amplify Deployment Status Change");
    }),
    { timeout: 60_000 },
  );

  test(
    "generateAccessLogs returns a pre-signed log URL for the default domain",
    Effect.gen(function* () {
      const meta = (yield* getJson("/meta")) as { defaultDomain: string };
      const result = (yield* postJson("/access-logs", {
        domainName: meta.defaultDomain,
      })) as {
        ok: boolean;
        logUrl?: string;
        errorTag?: string;
        message?: string;
        cause?: string;
      };
      if (result.ok) {
        expect(result.logUrl).toContain("https://");
      } else if (result.errorTag === "UnexpectedCause") {
        return yield* Effect.fail(
          new Error(result.cause ?? "GenerateAccessLogs failed unexpectedly"),
        );
      } else {
        // Some accounts gate access logs on the default domain — the typed
        // tag still proves the binding + IAM wiring.
        expect(["BadRequestException", "NotFoundException"]).toContain(
          result.errorTag,
        );
      }
    }),
    { timeout: 60_000, retry: 0 },
  );
});
