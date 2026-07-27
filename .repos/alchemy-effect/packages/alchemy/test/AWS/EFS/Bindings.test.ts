import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import EfsBindingsFunctionLive, {
  EfsBindingsFunction,
} from "./bindings-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "EFSBindings");

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

describe.sequential("EFS Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("EFS test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("EFS test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* EfsBindingsFunction;
        }).pipe(Effect.provide(EfsBindingsFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `EFS test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `EFS test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 240_000 });

  describe("binding registration", () => {
    test.provider("all 10 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/bindings`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).bound).toHaveLength(10);
      }),
    );
  });

  describe("DescribeFileSystem", () => {
    test.provider("reads the bound file system's description", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/file-system`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(response.fileSystemId).toMatch(/^fs-/);
        expect(response.state).toBe("available");
        expect(response.encrypted).toBe(true);
      }),
    );
  });

  describe("DescribeMountTargets", () => {
    test.provider("lists the file system's mount targets", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/mount-targets`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        // The fixture file system has no mount targets — assert the call
        // round-trips (FileSystemId injection + fs-scoped IAM).
        expect(response.count).toBe(0);
      }),
    );
  });

  describe("DescribeAccessPoints", () => {
    test.provider("lists the file system's access points", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/access-points`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(typeof response.count).toBe("number");
      }),
    );
  });

  describe("PutBackupPolicy + DescribeBackupPolicy", () => {
    test.provider("enables then disables automatic backups", (_stack) =>
      Effect.gen(function* () {
        const initial = (yield* send(
          HttpClientRequest.get(`${baseUrl}/backup-policy`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(["NONE", "DISABLED", "DISABLING"]).toContain(initial.status);

        const enabled = (yield* send(
          HttpClientRequest.post(`${baseUrl}/backup-policy/enable`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(["ENABLED", "ENABLING"]).toContain(enabled.status);

        const disabled = (yield* send(
          HttpClientRequest.post(`${baseUrl}/backup-policy/disable`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(["DISABLED", "DISABLING"]).toContain(disabled.status);
      }),
    );
  });

  describe("PutLifecycleConfiguration + DescribeLifecycleConfiguration", () => {
    test.provider("sets, reads, and clears lifecycle policies", (_stack) =>
      Effect.gen(function* () {
        const set = (yield* send(
          HttpClientRequest.post(`${baseUrl}/lifecycle/set`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(set.count).toBe(1);

        const read = (yield* send(
          HttpClientRequest.get(`${baseUrl}/lifecycle`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(read.count).toBe(1);

        const cleared = (yield* send(
          HttpClientRequest.post(`${baseUrl}/lifecycle/clear`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(cleared.count).toBe(0);
      }),
    );
  });

  describe("CreateAccessPoint + DeleteAccessPoint", () => {
    test.provider("creates and deletes an access point at runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.post(`${baseUrl}/access-point`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(response.accessPointId).toMatch(/^fsap-/);
        expect(response.deleted).toBe(true);
      }),
    );
  });

  describe("DescribeReplicationConfigurations", () => {
    test.provider(
      "returns the typed ReplicationNotFound for an unreplicated file system",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/replication`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;
          expect(response.hasReplication).toBe(false);
        }),
    );
  });
});
