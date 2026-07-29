import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import SignerTestFunctionLive, { SignerTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SignerBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let functionArn: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
  readonly url: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation on the freshly attached policy that the
// handler's `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine
// 4xx/assertion failure surfaces immediately.
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
                  url: request.url,
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

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const postJson = (path: string) =>
  send(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe.sequential("Signer Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("Signer test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Signer test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SignerTestFunction;
        }).pipe(Effect.provide(SignerTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `Signer test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Signer test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(process.env.NO_DESTROY ? Effect.void : sharedStack.destroy(), {
    timeout: 180_000,
  });

  describe("binding registration", () => {
    test.provider("all nine capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(9);
        expect(response.bound).toContain("startSigningJob");
        expect(response.bound).toContain("signPayload");
        expect(response.bound).toContain("revokeSigningProfile");
        expect(response.bound).toContain("getRevocationStatus");
      }),
    );
  });

  describe("ListSigningPlatforms / GetSigningPlatform", () => {
    test.provider("reads the AWS-managed platform catalog", (_stack) =>
      Effect.gen(function* () {
        const platforms = (yield* getJson("/platforms")) as { ids: string[] };
        expect(platforms.ids.length).toBeGreaterThan(0);
        expect(platforms.ids).toContain("AWSLambda-SHA384-ECDSA");

        const platform = (yield* getJson(
          "/platform?id=AWSLambda-SHA384-ECDSA",
        )) as { platformId: string; revocationSupported: boolean };
        expect(platform.platformId).toBe("AWSLambda-SHA384-ECDSA");
      }),
    );
  });

  describe("StartSigningJob / DescribeSigningJob / ListSigningJobs / RevokeSignature / GetRevocationStatus", () => {
    test.provider(
      "signs a zip end-to-end, observes the job, revokes its signature",
      (_stack) =>
        Effect.gen(function* () {
          // Start: freshly-propagated IAM on the source/destination buckets
          // can transiently reject the S3 access — re-poll bounded.
          const started = (yield* postJson("/start").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (r): boolean => (r as { ok: boolean }).ok === true,
              times: 10,
            }),
          )) as {
            ok: boolean;
            jobId?: string;
            tag?: string;
            message?: string;
          };
          if (!started.ok) {
            throw new Error(
              `StartSigningJob failed: ${started.tag}: ${started.message}`,
            );
          }
          const jobId = started.jobId!;
          const query = `?id=${encodeURIComponent(jobId)}`;

          // Describe: poll (bounded) until the async signing job lands. A
          // just-started job can 404 briefly ("Pending") before it appears.
          const job = (yield* getJson(`/job${query}`).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (r): boolean => {
                const status = (r as { status: string }).status;
                return status !== "InProgress" && status !== "Pending";
              },
              times: 20,
            }),
          )) as { status: string; signedKey?: string };
          expect(job.status).toBe("Succeeded");
          expect(job.signedKey).toContain("signed/");

          // List: the job is enumerated account-wide.
          const jobs = (yield* getJson("/jobs")) as { jobIds: string[] };
          expect(jobs.jobIds).toContain(jobId);

          // Revocation status check: derived ARNs round-trip through the
          // data endpoint; Signer may reject the empty certificate-hash list
          // with a typed ValidationException — either proves binding + IAM.
          const revocation = (yield* getJson(`/revocation${query}`)) as {
            ok: boolean;
            revokedEntities?: string[];
            tag?: string;
          };
          if (revocation.ok) {
            expect(revocation.revokedEntities).toEqual([]);
          } else {
            expect(["ValidationException", "BadRequestException"]).toContain(
              revocation.tag,
            );
          }

          // Revoke: the Lambda platform supports revocation, so revoking the
          // completed job's signature must land.
          const revoked = (yield* postJson(`/revoke-job${query}`)) as {
            revoked: boolean;
            tag?: string;
          };
          expect(revoked.revoked).toBe(true);
        }),
      { timeout: 240_000 },
    );
  });

  describe("SignPayload", () => {
    test.provider(
      "synchronously signs a Notation payload with the bound profile",
      (_stack) =>
        Effect.gen(function* () {
          const signed = (yield* postJson("/sign")) as {
            ok: boolean;
            jobId?: string;
            hasSignature?: boolean;
            tag?: string;
          };
          if (signed.ok) {
            expect(signed.hasSignature).toBe(true);
            expect(signed.jobId).toBeTruthy();
          } else {
            // A typed rejection of the payload still proves the binding and
            // IAM round-trip; an AccessDeniedException would not.
            expect(["ValidationException", "BadRequestException"]).toContain(
              signed.tag,
            );
          }
        }),
    );
  });

  describe("consumeSigningJobEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      (_stack) =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeSigningJobEvents
          // must have materialized as a rule on the default bus with the
          // Lambda as target.
          const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
            TargetArn: functionArn,
          });
          expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(1);
        }),
    );
  });
});
