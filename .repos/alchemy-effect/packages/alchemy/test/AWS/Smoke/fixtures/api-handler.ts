import * as AWS from "@/AWS";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  ServerlessResources,
  ServerlessResourcesLive,
} from "./serverless-resources.ts";

const plain = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

const PASSWORD = "Alchemy-Smoke-Passw0rd!";

/**
 * API Lambda: fronted by an API Gateway v2 HTTP API (see the test's stack
 * program for the JWT authorizer + protected routes). One route per
 * behavior of the serverless story:
 *
 * - `GET  /signup-free` → unauthenticated `$default` route, returns ok
 * - `POST /auth`        → Cognito signup + JWT mint via UserPoolAdmin/Auth
 * - `POST /todo`        → JWT-protected DynamoDB write
 * - `GET  /todo`        → JWT-protected DynamoDB read
 * - `GET  /upload-url`  → presigned S3 PUT URL
 * - `POST /enqueue`     → SQS SendMessage to the jobs queue
 * - `POST /compute`     → Step Functions EXPRESS StartSyncExecution
 * - `GET  /config`      → resource identifiers (readiness + cross-checks)
 */
export class SmokeApiFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "SmokeApiFunction",
) {}

export const SmokeApiFunctionLive = SmokeApiFunction.make(
  {
    main: import.meta.url,
    // /auth chains several Cognito calls and /compute round-trips a whole
    // workflow — AWS's 3s default intermittently times out on cold starts.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const { pool, client, table, bucket, jobsQueue, resultsQueue, machine } =
      yield* ServerlessResources;

    const admin = yield* AWS.Cognito.UserPoolAdmin(pool);
    const auth = yield* AWS.Cognito.UserPoolAuth(client);
    const putItem = yield* AWS.DynamoDB.PutItem(table);
    const getItem = yield* AWS.DynamoDB.GetItem(table);
    const presignPutObject = yield* AWS.S3.PresignPutObject(bucket);
    const sendMessage = yield* AWS.SQS.SendMessage(jobsQueue);
    const startSyncExecution =
      yield* AWS.StepFunctions.StartSyncExecution(machine);

    // Output → deferred effect; resolved per-request inside the handler.
    const UserPoolId = yield* pool.userPoolId;
    const ClientId = yield* client.clientId;
    const TableName = yield* table.tableName;
    const BucketName = yield* bucket.bucketName;
    const JobsQueueUrl = yield* jobsQueue.queueUrl;
    const ResultsQueueUrl = yield* resultsQueue.queueUrl;
    const MachineArn = yield* machine.stateMachineArn;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // The first event after a cold start can observe not-yet-hydrated
        // resource Outputs. Answer 503 so callers retry.
        const userPoolId = yield* UserPoolId;
        if (!userPoolId) {
          return HttpServerResponse.text("Outputs not hydrated yet", {
            status: 503,
          });
        }

        if (request.method === "GET" && pathname === "/config") {
          return yield* HttpServerResponse.json({
            ok: true,
            userPoolId,
            clientId: yield* ClientId,
            tableName: yield* TableName,
            bucketName: yield* BucketName,
            jobsQueueUrl: yield* JobsQueueUrl,
            resultsQueueUrl: yield* ResultsQueueUrl,
            machineArn: yield* MachineArn,
          });
        }

        // Unauthenticated route served by the $default catch-all.
        if (request.method === "GET" && pathname === "/signup-free") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        // Signup story: create + confirm a user through the UserPoolAdmin
        // binding, then mint JWTs through the UserPoolAuth binding.
        if (request.method === "POST" && pathname === "/auth") {
          const username = url.searchParams.get("username") ?? "smoke-user";
          yield* admin
            .adminCreateUser({
              Username: username,
              MessageAction: "SUPPRESS",
              UserAttributes: [
                { Name: "email", Value: `${username}@example.com` },
                { Name: "email_verified", Value: "true" },
              ],
            })
            .pipe(
              // rerun tolerance: an earlier run may have left the user
              Effect.catchTag("UsernameExistsException", () => Effect.void),
            );
          yield* admin.adminSetUserPassword({
            Username: username,
            Password: PASSWORD,
            Permanent: true,
          });
          const signIn = yield* auth.initiateAuth({
            AuthFlow: "USER_PASSWORD_AUTH",
            AuthParameters: { USERNAME: username, PASSWORD },
          });
          return yield* HttpServerResponse.json({
            idToken: plain(signIn.AuthenticationResult?.IdToken),
            accessToken: plain(signIn.AuthenticationResult?.AccessToken),
            tokenType: signIn.AuthenticationResult?.TokenType,
          });
        }

        // JWT-protected (enforced by the API Gateway JWT authorizer; the
        // request only reaches this code with a validated Cognito token).
        if (request.method === "POST" && pathname === "/todo") {
          const body = (yield* request.json) as unknown as {
            id: string;
            text: string;
          };
          yield* putItem({
            Item: {
              pk: { S: "todo" },
              sk: { S: body.id },
              text: { S: body.text },
            },
          });
          return yield* HttpServerResponse.json({ ok: true, id: body.id });
        }

        if (request.method === "GET" && pathname === "/todo") {
          const id = url.searchParams.get("id");
          if (!id) {
            return HttpServerResponse.text("Missing id", { status: 400 });
          }
          const result = yield* getItem({
            Key: { pk: { S: "todo" }, sk: { S: id } },
            ConsistentRead: true,
          });
          return yield* HttpServerResponse.json({
            item: result.Item
              ? { id: result.Item.sk?.S, text: result.Item.text?.S }
              : null,
          });
        }

        if (request.method === "GET" && pathname === "/upload-url") {
          const key = url.searchParams.get("key");
          if (!key) {
            return HttpServerResponse.text("Missing key", { status: 400 });
          }
          const contentType = url.searchParams.get("contentType");
          const presignedUrl = yield* presignPutObject({
            key,
            expiresIn: 300,
            contentType: contentType ?? undefined,
          });
          return yield* HttpServerResponse.json({ url: presignedUrl });
        }

        if (request.method === "POST" && pathname === "/enqueue") {
          const body = (yield* request.json) as unknown as {
            message: string;
          };
          const result = yield* sendMessage({ MessageBody: body.message });
          return yield* HttpServerResponse.json({
            messageId: result.MessageId,
          });
        }

        if (request.method === "POST" && pathname === "/compute") {
          const body = (yield* request.json) as unknown;
          const result = yield* startSyncExecution({
            input: JSON.stringify(body),
          });
          return yield* HttpServerResponse.json({
            status: result.status,
            output: plain(result.output),
            error: plain(result.error),
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.Cognito.UserPoolAdminHttp,
        AWS.Cognito.UserPoolAuthHttp,
        AWS.DynamoDB.PutItemHttp,
        AWS.DynamoDB.GetItemHttp,
        AWS.S3.PresignPutObjectHttp,
        AWS.SQS.SendMessageHttp,
        AWS.StepFunctions.StartSyncExecutionHttp,
        ServerlessResourcesLive,
      ),
    ),
  ),
).pipe(Layer.provideMerge(ServerlessResourcesLive));

export default SmokeApiFunctionLive;
