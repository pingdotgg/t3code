import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as transfer from "@distilled.cloud/aws/transfer";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import TransferTestFunctionLive, { TransferTestFunction } from "./handler";
import TransferWorkflowTestFunctionLive, {
  TransferWorkflowTestFunction,
} from "./workflow-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

const probeReady = (readinessUrl: string) =>
  HttpClient.get(readinessUrl).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.succeed(response)
        : Effect.fail(new Error(`Function not ready: ${response.status}`)),
    ),
    Effect.retry({ schedule: readinessPolicy }),
  );

// Ungated typed-error probes: prove the distilled error unions carry the
// tags the bindings and providers depend on, at near-zero cost.
describe("typed-error probes", () => {
  test.provider(
    "startServer on a nonexistent server fails with ResourceNotFoundException",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          transfer.startServer({ ServerId: "s-00000000000000000" }),
        );
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
  );

  test.provider(
    "importSshPublicKey on a nonexistent server fails with ResourceNotFoundException",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          transfer.importSshPublicKey({
            ServerId: "s-00000000000000000",
            UserName: "nobody",
            SshPublicKeyBody: "ssh-ed25519 AAAA",
          }),
        );
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
  );

  test.provider(
    "testIdentityProvider on a nonexistent server fails with ResourceNotFoundException",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          transfer.testIdentityProvider({
            ServerId: "s-00000000000000000",
            UserName: "nobody",
            UserPassword: Redacted.make("not-a-real-password"),
          }),
        );
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
  );

  test.provider(
    "sendWorkflowStepState on a nonexistent workflow fails with a typed tag",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          transfer.sendWorkflowStepState({
            WorkflowId: "w-1234567890abcdef0",
            ExecutionId: "00000000-0000-0000-0000-000000000000",
            Token: "MA==",
            Status: "SUCCESS",
          }),
        );
        // Transfer rejects the nonexistent workflow with the typed
        // ValidationException (from the shared CommonErrors union).
        expect([
          "ResourceNotFoundException",
          "InvalidRequestException",
          "ValidationException",
        ]).toContain(error._tag);
      }),
  );
});

// Ungated Lambda fixture: exercises the account-level binding + the
// EventBridge event source without provisioning a Transfer server.
describe.sequential("Transfer workflow binding", () => {
  const workflowStack = Core.scratchStack(
    testOptions,
    "TransferWorkflowBindings",
  );

  let baseUrl: string;
  let functionArn: string;

  beforeAll(
    Effect.gen(function* () {
      yield* workflowStack.destroy();

      const attrs = yield* workflowStack.deploy(
        Effect.gen(function* () {
          return yield* TransferWorkflowTestFunction;
        }).pipe(Effect.provide(TransferWorkflowTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      yield* probeReady(`${baseUrl}/bindings`);
    }),
    { timeout: 300_000 },
  );

  afterAll(workflowStack.destroy(), { timeout: 180_000 });

  test.provider("the capability initializes in the runtime", (_stack) =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`${baseUrl}/bindings`).pipe(
        Effect.flatMap((r) => r.json),
      );
      expect((response as { bound: string[] }).bound).toContain(
        "sendWorkflowStepState",
      );
    }),
  );

  test.provider(
    "SendWorkflowStepState round-trips and rejects with a typed tag",
    (_stack) =>
      Effect.gen(function* () {
        const response = (yield* HttpClient.execute(
          HttpClientRequest.post(`${baseUrl}/workflow-step`),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          ok: boolean;
          tag?: string;
        };
        // The workflow does not exist — the call must surface the typed
        // rejection (not an untyped catch-all, not an IAM denial).
        expect(response.ok).toBe(false);
        expect([
          "ResourceNotFoundException",
          "InvalidRequestException",
          "ValidationException",
        ]).toContain(response.tag);
      }),
  );

  test.provider(
    "consumeFileTransferEvents created an EventBridge rule targeting the function",
    (_stack) =>
      Effect.gen(function* () {
        // Out-of-band via distilled: the fixture's consumeFileTransferEvents
        // must have materialized as a rule on the default bus with the
        // Lambda as target.
        const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
          TargetArn: functionArn,
        });
        expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(1);
      }),
  );
});

// A running Transfer server is billed hourly and takes minutes to reach
// ONLINE, so the server/user-scoped binding lifecycle is gated behind
// AWS_TEST_SLOW=1 (same gate as Server.test.ts) and always destroys what it
// created.
describe.runIf(!!process.env.AWS_TEST_SLOW)(
  "Transfer server bindings (slow)",
  () => {
    const serverStack = Core.scratchStack(testOptions, "TransferBindings");

    let baseUrl: string;

    const getJson = (path: string) =>
      HttpClient.get(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));

    const send = (method: "POST" | "DELETE", path: string) =>
      HttpClient.execute(
        method === "POST"
          ? HttpClientRequest.post(`${baseUrl}${path}`)
          : HttpClientRequest.delete(`${baseUrl}${path}`),
      ).pipe(Effect.flatMap((r) => r.json));

    beforeAll(
      Effect.gen(function* () {
        yield* serverStack.destroy();

        const attrs = yield* serverStack.deploy(
          Effect.gen(function* () {
            return yield* TransferTestFunction;
          }).pipe(Effect.provide(TransferTestFunctionLive)),
        );

        expect(attrs.functionUrl).toBeTruthy();
        baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

        yield* probeReady(`${baseUrl}/bindings`);
      }),
      { timeout: 210_000 },
    );

    afterAll(serverStack.destroy(), { timeout: 90_000 });

    test.provider(
      "all eight capabilities initialize in the runtime",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/bindings")) as { bound: string[] };
          expect(response.bound).toHaveLength(8);
          expect(response.bound).toContain("describeServer");
          expect(response.bound).toContain("importSshPublicKey");
        }),
    );

    test.provider(
      "reads the bound server and lists its users (injected ServerId)",
      (_stack) =>
        Effect.gen(function* () {
          const server = (yield* getJson("/server")) as {
            serverId: string;
            state: string;
          };
          expect(server.serverId).toMatch(/^s-/);

          const users = (yield* getJson("/users")) as { userNames: string[] };
          expect(users.userNames).toContain("alice");
        }),
    );

    test.provider(
      "imports, observes, and deletes an SSH key on the bound user",
      (_stack) =>
        Effect.gen(function* () {
          const imported = (yield* send("POST", "/key")) as {
            ok: boolean;
            keyId?: string;
            tag?: string;
          };
          expect(imported.ok).toBe(true);
          const keyId = imported.keyId!;

          const user = (yield* getJson("/user")) as {
            userName: string;
            keyIds: string[];
          };
          expect(user.userName).toBe("alice");
          expect(user.keyIds).toContain(keyId);

          const deleted = (yield* send(
            "DELETE",
            `/key?id=${encodeURIComponent(keyId)}`,
          )) as { ok: boolean };
          expect(deleted.ok).toBe(true);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "TestIdentityProvider on a SERVICE_MANAGED server rejects with the typed tag",
      (_stack) =>
        Effect.gen(function* () {
          const tested = (yield* send("POST", "/test-idp")) as {
            ok: boolean;
            tag?: string;
          };
          expect(tested.ok).toBe(false);
          expect(tested.tag).toBe("InvalidRequestException");
        }),
    );

    // A stop/offline/start transition adds several minutes beyond the already
    // slow server provisioning lifecycle. Keep it separately opt-in so the
    // standard AWS_TEST_SLOW lane remains below the hard 240-second wall.
    test.provider.skipIf(!process.env.AWS_TEST_TRANSFER_TRANSITIONS)(
      "stops and restarts the bound server (extra slow)",
      (_stack) =>
        Effect.gen(function* () {
          const stopped = (yield* send("POST", "/stop")) as {
            ok: boolean;
            tag?: string;
          };
          expect(stopped.ok).toBe(true);

          // The server parks in STOPPING before OFFLINE.
          const offline = (yield* getJson("/server").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (r): boolean =>
                (r as { state: string }).state === "OFFLINE",
              times: 8,
            }),
          )) as { state: string };
          expect(offline.state).toBe("OFFLINE");

          const started = (yield* send("POST", "/start")) as {
            ok: boolean;
            tag?: string;
          };
          expect(started.ok).toBe(true);
        }),
      { timeout: 120_000 },
    );
  },
);
