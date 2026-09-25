import * as AWS from "@/AWS";
import * as Output from "@/Output";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as agw2 from "@distilled.cloud/aws/apigatewayv2";
import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import * as ddb from "@distilled.cloud/aws/dynamodb";
import * as lambda from "@distilled.cloud/aws/lambda";
import * as S3 from "@distilled.cloud/aws/s3";
import * as sfn from "@distilled.cloud/aws/sfn";
import * as sqs from "@distilled.cloud/aws/sqs";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import SmokeApiFunctionLive, {
  SmokeApiFunction,
} from "./fixtures/api-handler.ts";
import { ServerlessResources } from "./fixtures/serverless-resources.ts";
import SmokeWorkerFunctionLive, {
  SmokeWorkerFunction,
} from "./fixtures/worker-handler.ts";

/**
 * Phase-1 exit flagship: the full-stack serverless story in ONE stack.
 *
 * Cognito UserPool + Client → API Gateway v2 HTTP API (JWT authorizer)
 * → API Lambda binding DynamoDB, S3 presign, SQS, and an EXPRESS Step
 * Function → worker Lambda consuming the jobs queue via the SQS event
 * source. The test drives the story over HTTP and verifies every side
 * effect out-of-band via distilled.
 */

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ServerlessSmoke");

// Lambda cold start + API Gateway route/permission propagation can take
// well over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(90),
]);

interface StackOutputs {
  url: string;
  apiId: string;
  userPoolId: string;
  clientId: string;
  tableName: string;
  bucketName: string;
  jobsQueueUrl: string;
  jobsQueueArn: string;
  resultsQueueUrl: string;
  machineArn: string;
  workerFunctionName: string;
  apiFunctionName: string;
}

let outputs: StackOutputs;
let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

class UnexpectedStatus extends Data.TaggedError("UnexpectedStatus")<{
  readonly status: number;
  readonly expected: number;
}> {}

class StillExists extends Data.TaggedError("StillExists")<{
  readonly what: string;
}> {}

class MessageNotDelivered extends Data.TaggedError("MessageNotDelivered") {}

class EventSourceMappingNotReady extends Data.TaggedError(
  "EventSourceMappingNotReady",
) {}

// Retry transient 5xx only (cold re-init, IAM propagation); 4xx and
// assertion failures surface immediately.
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

// Poll until the API answers a request with the expected status — rides out
// the short window while a freshly-created route/authorizer propagates.
const awaitStatus = (
  request: HttpClientRequest.HttpClientRequest,
  expected: number,
  times = 20,
) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status === expected
        ? Effect.succeed(response)
        : Effect.fail(
            new UnexpectedStatus({ status: response.status, expected }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "UnexpectedStatus",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(times),
      ]),
    }),
  );

// Bounded wait until an out-of-band probe reports the resource gone.
const waitUntilGone = <E, R>(
  what: string,
  probe: Effect.Effect<boolean, E, R>,
) =>
  probe.pipe(
    Effect.flatMap((gone) =>
      gone ? Effect.void : Effect.fail(new StillExists({ what })),
    ),
    Effect.retry({
      // `instanceof`, not `_tag`: the probe's error type `E` is generic and
      // carries no tag constraint.
      while: (e) => e instanceof StillExists,
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(30),
      ]),
    }),
  );

const deployProgram = Effect.gen(function* () {
  const { pool, client, table, bucket, jobsQueue, resultsQueue, machine } =
    yield* ServerlessResources;
  const apiFn = yield* SmokeApiFunction;
  const worker = yield* SmokeWorkerFunction;

  const { api, integration, url } = yield* AWS.ApiGatewayV2.HttpApi(
    "SmokeHttpApi",
    { handler: apiFn },
  );

  // JWT authorizer wired to the Cognito user pool. The pool id embeds its
  // region (`us-west-2_Abc123`), so the issuer URL is derived from it.
  const authorizer = yield* AWS.ApiGatewayV2.Authorizer("SmokeJwtAuthorizer", {
    api,
    authorizerType: "JWT",
    identitySource: ["$request.header.Authorization"],
    jwtConfiguration: {
      Issuer: Output.map(
        pool.userPoolId,
        (id) => `https://cognito-idp.${id.split("_")[0]}.amazonaws.com/${id}`,
      ),
      Audience: [client.clientId],
    },
  });

  yield* AWS.ApiGatewayV2.Route("TodoPostRoute", {
    api,
    routeKey: "POST /todo",
    integration,
    authorizationType: "JWT",
    authorizerId: authorizer.authorizerId,
  });
  yield* AWS.ApiGatewayV2.Route("TodoGetRoute", {
    api,
    routeKey: "GET /todo",
    integration,
    authorizationType: "JWT",
    authorizerId: authorizer.authorizerId,
  });

  return {
    url,
    apiId: api.apiId,
    userPoolId: pool.userPoolId,
    clientId: client.clientId,
    tableName: table.tableName,
    bucketName: bucket.bucketName,
    jobsQueueUrl: jobsQueue.queueUrl,
    jobsQueueArn: jobsQueue.queueArn,
    resultsQueueUrl: resultsQueue.queueUrl,
    machineArn: machine.stateMachineArn,
    workerFunctionName: worker.functionName,
    apiFunctionName: apiFn.functionName,
  };
}).pipe(
  Effect.provide(Layer.mergeAll(SmokeApiFunctionLive, SmokeWorkerFunctionLive)),
);

describe.sequential("Serverless smoke", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("Serverless smoke: destroying previous stack");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Serverless smoke: deploying stack");
      outputs = (yield* sharedStack.deploy(deployProgram)) as StackOutputs;
      baseUrl = outputs.url.replace(/\/+$/, "");

      yield* Effect.logInfo(`Serverless smoke: probing ${baseUrl}/config`);
      const config = (yield* HttpClient.get(`${baseUrl}/config`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.json
            : Effect.fail(new Error(`API not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Serverless smoke: API not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      )) as {
        userPoolId: string;
        clientId: string;
        tableName: string;
        bucketName: string;
        jobsQueueUrl: string;
        resultsQueueUrl: string;
        machineArn: string;
      };

      // The fixture Lambdas and the stack program declare the shared
      // resources through ONE layer — the identifiers the deployed Lambda
      // observes must be the same physical resources the stack returned.
      expect(config.userPoolId).toBe(outputs.userPoolId);
      expect(config.clientId).toBe(outputs.clientId);
      expect(config.tableName).toBe(outputs.tableName);
      expect(config.bucketName).toBe(outputs.bucketName);
      expect(config.jobsQueueUrl).toBe(outputs.jobsQueueUrl);
      expect(config.resultsQueueUrl).toBe(outputs.resultsQueueUrl);
      expect(config.machineArn).toBe(outputs.machineArn);
    }),
    { timeout: 300_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  test.provider(
    "unauthenticated $default route serves; JWT routes are gated",
    (_stack) =>
      Effect.gen(function* () {
        const free = yield* send(
          HttpClientRequest.get(`${baseUrl}/signup-free`),
        );
        expect(free.status).toBe(200);
        expect((yield* free.json) as object).toEqual({ ok: true });

        // No token → the JWT authorizer must answer 401 before the Lambda
        // is ever invoked. Polls through route/authorizer propagation.
        const unauthorized = yield* awaitStatus(
          HttpClientRequest.post(`${baseUrl}/todo`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ id: "nope", text: "nope" }),
          ),
          401,
        );
        expect(unauthorized.status).toBe(401);

        // Garbage token → still 401.
        const garbage = yield* HttpClient.execute(
          HttpClientRequest.post(`${baseUrl}/todo`).pipe(
            HttpClientRequest.setHeader("Authorization", "Bearer not-a-jwt"),
            HttpClientRequest.bodyJsonUnsafe({ id: "nope", text: "nope" }),
          ),
        );
        expect(garbage.status).toBe(401);

        // The gated write never reached DynamoDB.
        const item = yield* ddb.getItem({
          TableName: outputs.tableName,
          Key: { pk: { S: "todo" }, sk: { S: "nope" } },
          ConsistentRead: true,
        });
        expect(item.Item).toBeUndefined();
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "Cognito JWT (minted via UserPoolAdmin/UserPoolAuth bindings) unlocks the todo API",
    (_stack) =>
      Effect.gen(function* () {
        const tokens = (yield* send(
          HttpClientRequest.post(
            `${baseUrl}/auth?username=serverless-smoke-user`,
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          idToken: string | undefined;
          accessToken: string | undefined;
          tokenType: string | undefined;
        };
        expect(tokens.tokenType).toBe("Bearer");
        expect(tokens.idToken).toBeTruthy();

        const authorize = HttpClientRequest.setHeader(
          "Authorization",
          `Bearer ${tokens.idToken}`,
        );

        const text = "ship the serverless smoke";
        const wrote = yield* awaitStatus(
          HttpClientRequest.post(`${baseUrl}/todo`).pipe(
            authorize,
            HttpClientRequest.bodyJsonUnsafe({ id: "todo-1", text }),
          ),
          200,
          10,
        );
        expect((yield* wrote.json) as object).toEqual({
          ok: true,
          id: "todo-1",
        });

        const read = yield* send(
          HttpClientRequest.get(`${baseUrl}/todo?id=todo-1`).pipe(authorize),
        );
        expect(read.status).toBe(200);
        expect((yield* read.json) as object).toEqual({
          item: { id: "todo-1", text },
        });

        // Out-of-band: the item really landed in the table.
        const raw = yield* ddb.getItem({
          TableName: outputs.tableName,
          Key: { pk: { S: "todo" }, sk: { S: "todo-1" } },
          ConsistentRead: true,
        });
        expect(raw.Item?.text?.S).toBe(text);
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "presigned PUT URL uploads into the bucket",
    (_stack) =>
      Effect.gen(function* () {
        const key = "smoke/upload.txt";
        const body = "uploaded through the serverless smoke story";

        const presigned = (yield* send(
          HttpClientRequest.get(
            `${baseUrl}/upload-url?key=${encodeURIComponent(key)}&contentType=text/plain`,
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as { url: string };
        expect(presigned.url).toContain(outputs.bucketName);

        const put = yield* send(
          HttpClientRequest.put(presigned.url).pipe(
            HttpClientRequest.bodyText(body, "text/plain"),
          ),
        );
        expect(put.status).toBe(200);

        // Out-of-band: fetch the object back via distilled.
        const got = yield* S3.getObject({
          Bucket: outputs.bucketName,
          Key: key,
        });
        expect(got.ContentType).toBe("text/plain");
        const text = yield* Stream.mkString(Stream.decodeText(got.Body!));
        expect(text).toBe(body);
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "enqueued message is observed by the worker Lambda via the SQS event source",
    (_stack) =>
      Effect.gen(function* () {
        // The event-source mapping activates asynchronously after deploy.
        yield* lambda
          .listEventSourceMappings({
            FunctionName: outputs.workerFunctionName,
            EventSourceArn: outputs.jobsQueueArn,
          })
          .pipe(
            Effect.flatMap((result) => {
              const mapping = result.EventSourceMappings?.[0];
              return mapping?.State === "Enabled"
                ? Effect.succeed(mapping)
                : Effect.fail(new EventSourceMappingNotReady());
            }),
            Effect.retry({
              while: (e) => e._tag === "EventSourceMappingNotReady",
              schedule: Schedule.max([
                Schedule.fixed("2 seconds"),
                Schedule.recurs(30),
              ]),
            }),
          );

        const message = yield* Effect.sync(
          () => `smoke-job-${crypto.randomUUID()}`,
        );
        const enqueued = (yield* send(
          HttpClientRequest.post(`${baseUrl}/enqueue`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ message }),
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as { messageId: string };
        expect(enqueued.messageId).toBeTruthy();

        // The worker forwards `processed:{body}` into the results queue —
        // poll it out-of-band (bounded: ~30 polls × 2s long-poll).
        const received = yield* Effect.gen(function* () {
          const result = yield* sqs.receiveMessage({
            QueueUrl: outputs.resultsQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 2,
          });
          const match = (result.Messages ?? []).find(
            (m) => m.Body === `processed:${message}`,
          );
          if (!match?.ReceiptHandle) {
            return yield* Effect.fail(new MessageNotDelivered());
          }
          yield* sqs.deleteMessage({
            QueueUrl: outputs.resultsQueueUrl,
            ReceiptHandle: match.ReceiptHandle,
          });
          return match.Body!;
        }).pipe(
          Effect.retry({
            while: (e) => e._tag === "MessageNotDelivered",
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(30),
            ]),
          }),
        );
        expect(received).toBe(`processed:${message}`);
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "EXPRESS Step Function round-trips synchronously from the API Lambda",
    (_stack) =>
      Effect.gen(function* () {
        const result = (yield* send(
          HttpClientRequest.post(`${baseUrl}/compute`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ value: 21 }),
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          status: string;
          output: string | undefined;
          error: string | undefined;
        };

        expect(result.error).toBeUndefined();
        expect(result.status).toBe("SUCCEEDED");
        const output = JSON.parse(result.output!) as {
          computed: boolean;
          echo: { value: number };
        };
        expect(output.computed).toBe(true);
        expect(output.echo).toEqual({ value: 21 });
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "destroy removes the pool, api, table, bucket, queues, and state machine",
    (_stack) =>
      Effect.gen(function* () {
        yield* sharedStack.destroy();

        yield* waitUntilGone(
          "user pool",
          cip.describeUserPool({ UserPoolId: outputs.userPoolId }).pipe(
            Effect.map(() => false),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(true),
            ),
          ),
        );

        yield* waitUntilGone(
          "http api",
          agw2.getApi({ ApiId: outputs.apiId }).pipe(
            Effect.map(() => false),
            Effect.catchTag("NotFoundException", () => Effect.succeed(true)),
          ),
        );

        yield* waitUntilGone(
          "table",
          ddb.describeTable({ TableName: outputs.tableName }).pipe(
            Effect.map(() => false),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(true),
            ),
          ),
        );

        yield* waitUntilGone(
          "bucket",
          S3.headBucket({ Bucket: outputs.bucketName }).pipe(
            Effect.map(() => false),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
          ),
        );

        yield* waitUntilGone(
          "jobs queue",
          sqs
            .getQueueUrl({ QueueName: queueNameFromUrl(outputs.jobsQueueUrl) })
            .pipe(
              Effect.map(() => false),
              Effect.catchTag("QueueDoesNotExist", () => Effect.succeed(true)),
            ),
        );

        yield* waitUntilGone(
          "results queue",
          sqs
            .getQueueUrl({
              QueueName: queueNameFromUrl(outputs.resultsQueueUrl),
            })
            .pipe(
              Effect.map(() => false),
              Effect.catchTag("QueueDoesNotExist", () => Effect.succeed(true)),
            ),
        );

        yield* waitUntilGone(
          "api lambda",
          lambda.getFunction({ FunctionName: outputs.apiFunctionName }).pipe(
            Effect.map(() => false),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(true),
            ),
          ),
        );

        yield* waitUntilGone(
          "worker lambda",
          lambda.getFunction({ FunctionName: outputs.workerFunctionName }).pipe(
            Effect.map(() => false),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(true),
            ),
          ),
        );

        yield* waitUntilGone(
          "state machine",
          sfn
            .describeStateMachine({ stateMachineArn: outputs.machineArn })
            .pipe(
              Effect.map((machine) => machine.status === "DELETING"),
              Effect.catchTag("StateMachineDoesNotExist", () =>
                Effect.succeed(true),
              ),
            ),
        );
      }),
    { timeout: 120_000 },
  );
});

const queueNameFromUrl = (queueUrl: string) => queueUrl.split("/").at(-1)!;
