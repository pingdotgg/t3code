import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import FSxBindingsFunctionLive, {
  FSxBindingsFunction,
} from "./bindings-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "FSxBindings");

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

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const postJson = (path: string) =>
  send(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe.sequential("FSx Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("FSx test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("FSx test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* FSxBindingsFunction;
        }).pipe(Effect.provide(FSxBindingsFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `FSx test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `FSx test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 240_000 });

  describe("binding registration", () => {
    test.provider("all 14 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as any;
        expect(response.bound).toHaveLength(14);
      }),
    );
  });

  describe("DescribeBackups", () => {
    test.provider("lists the account's FSx backups", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/backups")) as any;
        expect(typeof response.count).toBe("number");
      }),
    );
  });

  describe("DescribeSnapshots", () => {
    test.provider("lists the account's OpenZFS snapshots", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/snapshots")) as any;
        expect(typeof response.count).toBe("number");
      }),
    );
  });

  describe("DescribeVolumes", () => {
    test.provider("lists the account's ONTAP/OpenZFS volumes", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/volumes")) as any;
        expect(typeof response.count).toBe("number");
      }),
    );
  });

  describe("DescribeStorageVirtualMachines", () => {
    test.provider("lists the account's ONTAP SVMs", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/svms")) as any;
        expect(typeof response.count).toBe("number");
      }),
    );
  });

  describe("DescribeDataRepositoryTasks", () => {
    test.provider("lists the account's data repository tasks", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/dr-tasks")) as any;
        expect(typeof response.count).toBe("number");
      }),
    );
  });

  describe("DescribeDataRepositoryAssociations", () => {
    test.provider(
      "lists the account's data repository associations",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/dr-associations")) as any;
          expect(typeof response.count).toBe("number");
        }),
    );
  });

  describe("DeleteBackup", () => {
    test.provider(
      "returns the typed BackupNotFound for a missing backup",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/backup/delete-missing")) as any;
          expect(response.tag).toBe("BackupNotFound");
        }),
    );
  });

  describe("CopyBackup", () => {
    test.provider(
      "returns the typed BackupNotFound for a missing source backup",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/backup/copy-missing")) as any;
          expect(response.tag).toBe("BackupNotFound");
        }),
    );
  });

  describe("UpdateSnapshot", () => {
    // FSx misclassifies this not-found as a wire `BadRequest`; the distilled
    // patch (patches/fsx.json) carves the typed UpdateSnapshotNotFound out
    // of it by message predicate.
    test.provider(
      "returns the typed UpdateSnapshotNotFound for a missing snapshot",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/snapshot/update-missing")) as any;
          expect(response.tag).toBe("UpdateSnapshotNotFound");
        }),
    );
  });

  describe("DeleteSnapshot", () => {
    test.provider(
      "returns the typed SnapshotNotFound for a missing snapshot",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/snapshot/delete-missing")) as any;
          expect(response.tag).toBe("SnapshotNotFound");
        }),
    );
  });

  describe("CreateSnapshot", () => {
    // FSx misclassifies this not-found as a wire `BadRequest`; the distilled
    // patch (patches/fsx.json) carves the typed SnapshotVolumeNotFound out
    // of it by message predicate.
    test.provider(
      "returns the typed SnapshotVolumeNotFound for a missing volume",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson(
            "/snapshot/create-missing-volume",
          )) as any;
          expect(response.tag).toBe("SnapshotVolumeNotFound");
        }),
    );
  });

  describe("RestoreVolumeFromSnapshot", () => {
    // FSx misclassifies this not-found as a wire `BadRequest`; the distilled
    // patch (patches/fsx.json) carves the typed RestoreSnapshotNotFound out
    // of it by message predicate.
    test.provider(
      "returns the typed RestoreSnapshotNotFound for a missing snapshot",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/volume/restore-missing")) as any;
          expect(response.tag).toBe("RestoreSnapshotNotFound");
        }),
    );
  });

  describe("CopySnapshotAndUpdateVolume", () => {
    // FSx reports a nonexistent source snapshot as a wire `BadRequest` with
    // "SourceSnapshotARN provided is not a valid ARN"; the distilled patch
    // (patches/fsx.json) carves the typed SourceSnapshotNotFound out of it
    // by message predicate.
    test.provider(
      "returns the typed SourceSnapshotNotFound for a missing source snapshot",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson(
            "/volume/copy-snapshot-missing",
          )) as any;
          expect(response.tag).toBe("SourceSnapshotNotFound");
        }),
    );
  });

  describe("CancelDataRepositoryTask", () => {
    test.provider(
      "returns the typed DataRepositoryTaskNotFound for a missing task",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/dr-task/cancel-missing")) as any;
          expect(response.tag).toBe("DataRepositoryTaskNotFound");
        }),
    );
  });
});
