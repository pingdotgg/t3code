import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import { Bucket, bucketStorageClient } from "@/Neon/Bucket";
import {
  Object as NeonObject,
  serializeObjectValue,
  storageBodyBytes,
} from "@/Neon/Object";
import { Project } from "@/Neon/Project";
import { providers } from "@/Neon/Providers";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: providers() });

test(
  "JSON serialization is stable and rejects lossy values",
  Effect.gen(function* () {
    expect(
      yield* serializeObjectValue({
        z: [true, null, "str"],
        a: { y: 2, x: 1 },
      }),
    ).toBe('{"a":{"x":1,"y":2},"z":[true,null,"str"]}');
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const hiddenRecord = yield* Effect.sync(() =>
      Object.defineProperty({}, "hidden", { value: 1 }),
    );
    const hiddenArray = yield* Effect.sync(() =>
      Object.defineProperty([1], "hidden", { value: 2 }),
    );
    let accessed = false;
    const accessor = {
      get value() {
        accessed = true;
        return 1;
      },
    };
    const accessorArray = yield* Effect.sync(() =>
      Object.defineProperty([1], "0", {
        get() {
          accessed = true;
          return 1;
        },
      }),
    );
    for (const value of [
      hiddenRecord,
      hiddenArray,
      accessor,
      accessorArray,
      undefined,
      NaN,
      Infinity,
      1n,
      { lost: undefined },
      [, 1],
      cycle,
      new Date(0),
      { [Symbol("key")]: 1 },
    ]) {
      expect(
        Result.isFailure(
          yield* serializeObjectValue(value).pipe(Effect.result),
        ),
      ).toBe(true);
    }
    expect(accessed).toBe(false);
  }),
  { tags: ["provider:neon", "provider:neon:object", "live"] },
);

test.provider(
  "typed JSON updates metadata file fidelity movement and deletion",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "neon-object-" });
      const source = path.join(dir, "object.bin");
      const bytes = new Uint8Array([0, 255, 1, 127, 32]);
      yield* fs.writeFile(source, bytes);
      const deploy = (updated: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const project = yield* Project("ObjectProject", {
              region: "aws-us-east-2",
            });
            const bucket = yield* Bucket("Objects", { project });
            const object = yield* NeonObject("Settings", {
              bucket,
              key: updated ? "new/settings.json" : "settings.json",
              value: {
                theme: updated ? "dark" : "system",
                pageSize: updated ? 50 : 25,
              },
              cacheControl: updated ? "no-store" : "max-age=60",
              metadata: updated ? {} : { Phase: "initial" },
            });
            const raw = yield* NeonObject("Bytes", {
              bucket,
              key: "raw.bin",
              source,
            });
            return { bucket, object, raw };
          }),
        );
      const first = yield* deploy(false);
      const client = yield* bucketStorageClient(first.bucket);
      const stored = yield* client.get(first.object.key);
      expect(stored?.ContentType).toBe("application/json");
      expect(stored?.Metadata?.phase).toBe("initial");
      const json = yield* storageBodyBytes(stored?.Body);
      expect(yield* Effect.sync(() => new TextDecoder().decode(json))).toBe(
        '{"pageSize":25,"theme":"system"}',
      );
      expect(
        Array.from(
          yield* storageBodyBytes((yield* client.get("raw.bin"))?.Body),
        ),
      ).toEqual(Array.from(bytes));
      const unchanged = yield* deploy(false);
      expect(unchanged.object.etag).toBe(first.object.etag);
      const updated = yield* deploy(true);
      expect(updated.object.key).toBe("new/settings.json");
      expect(yield* client.get("settings.json")).toBeUndefined();
      expect((yield* client.head(updated.object.key))?.CacheControl).toBe(
        "no-store",
      );
      const listing = yield* SDK.listProjectBranchBucketObjects({
        project_id: updated.bucket.projectId,
        branch_id: updated.bucket.branchId,
        bucket_name: updated.bucket.bucketName,
      });
      expect(listing).toBeDefined();
      yield* stack.destroy();
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:bucket",
      "provider:neon:object",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "foreign object requires adoption and adopted content converges",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucketProgram = Effect.gen(function* () {
        const project = yield* Project("ObjectAdoptionProject", {
          region: "aws-us-east-2",
        });
        return yield* Bucket("AdoptionBucket", { project, forceDestroy: true });
      });
      const bucket = yield* stack.deploy(bucketProgram);
      const client = yield* bucketStorageClient(bucket);
      yield* client.put("foreign.json", '{"count":0}', {
        ContentType: "application/json",
        Metadata: { foreign: "yes" },
      });
      const program = (takeover: boolean, version = 1) =>
        Effect.gen(function* () {
          const bucket = yield* bucketProgram;
          return yield* NeonObject("AdoptedObject", {
            bucket,
            key: "foreign.json",
            value: { count: 1 },
            metadata: { version: String(version) },
          }).pipe(adopt(takeover));
        });
      const refused = yield* stack.deploy(program(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused))
        expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);
      expect((yield* client.head("foreign.json"))?.Metadata?.foreign).toBe(
        "yes",
      );
      const adopted = yield* stack.deploy(program(true));
      expect(adopted.metadata["alchemy-id"]).toBe("AdoptedObject");
      yield* client.put("foreign.json", '{"count":999}', {
        Metadata: adopted.metadata,
      });
      const repaired = yield* stack.deploy(program(true, 2));
      expect(repaired.contentHash).toBe(adopted.contentHash);
      const bytes = yield* storageBodyBytes(
        (yield* client.get("foreign.json"))?.Body,
      );
      expect(yield* Effect.sync(() => new TextDecoder().decode(bytes))).toBe(
        '{"count":1}',
      );
      yield* client.delete("foreign.json");
      const recreated = yield* stack.deploy(program(true, 3));
      expect(recreated.contentHash).toBe(adopted.contentHash);
      yield* stack.destroy();
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:bucket",
      "provider:neon:object",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);
