import type { Bucket } from "@/Neon/Bucket";
import { Object as NeonObject } from "@/Neon/Object";
import { ReadObject } from "@/Neon/ReadObject";
import { WriteObject } from "@/Neon/WriteObject";
import { ReadBucket } from "@/Neon/ReadBucket";
import { WriteBucket } from "@/Neon/WriteBucket";
import * as Effect from "effect/Effect";
import * as Output from "@/Output";
import * as Schema from "effect/Schema";
import { expect, test } from "alchemy-test";

interface Settings {
  theme: "system" | "light" | "dark";
  pageSize: number;
}

const typeCases = (bucket: Bucket) =>
  Effect.gen(function* () {
    const inferred = yield* NeonObject("Inferred", {
      bucket,
      key: "inferred.json",
      value: { theme: "system", pageSize: 25 },
    });
    const inferredReader = yield* ReadObject(inferred);
    const inferredValue: { theme: string; pageSize: number } | undefined =
      yield* inferredReader.get();
    const inferredWriter = yield* WriteObject(inferred);
    yield* inferredWriter.put({ theme: "dark", pageSize: 50 });
    // @ts-expect-error pageSize remains numeric through the object binding.
    yield* inferredWriter.put({ theme: "dark", pageSize: "50" });
    const explicit = yield* NeonObject<Settings>("Explicit", {
      bucket,
      key: "settings.json",
      value: { theme: "system", pageSize: 25 },
    });
    const reader = yield* ReadObject(explicit);
    const value: Settings | undefined = yield* reader.get();
    const writer = yield* WriteObject(explicit);
    yield* writer.put({ theme: "dark", pageSize: 50 });
    // @ts-expect-error The explicit theme union is retained.
    yield* writer.put({ theme: "blue", pageSize: 50 });
    const invalidSettings = {
      bucket,
      key: "bad.json",
      value: { theme: "blue", pageSize: 1 },
    };
    // @ts-expect-error Explicit generic constrains the declared JSON value.
    yield* NeonObject<Settings>("Bad", invalidSettings);
    // @ts-expect-error JSON and raw body forms are mutually exclusive.
    yield* NeonObject("Mixed", { bucket, key: "mixed", value: 1, body: "raw" });
    // @ts-expect-error File and body forms are mutually exclusive.
    yield* NeonObject("MixedFile", {
      bucket,
      key: "mixed",
      source: "file.txt",
      body: "raw",
    });
    const raw = yield* NeonObject("Raw", {
      bucket,
      key: "raw",
      body: new Uint8Array([1]),
    });
    const rawReader = yield* ReadObject(raw);
    const rawValue: Uint8Array | undefined = yield* rawReader.get();
    const rawWriter = yield* WriteObject(raw);
    yield* rawWriter.put(new Uint8Array([2]));
    // @ts-expect-error Raw objects do not accept arbitrary JSON records.
    yield* rawWriter.put({ hello: "world" });
    yield* NeonObject("Validated", {
      bucket,
      key: "validated.json",
      value: { count: 1 },
      schema: Schema.Struct({ count: Schema.Number }),
    });
    const outputs = yield* NeonObject<{ count: number }>("Outputs", {
      bucket,
      key: "outputs.json",
      value: { count: Output.literal(1) },
    });
    const outputReader = yield* ReadObject(outputs);
    const outputValue: { count: number } | undefined =
      yield* outputReader.get();
    const readBucket = yield* ReadBucket(bucket);
    // @ts-expect-error Read-only API cannot upload.
    readBucket.put("key", "value");
    // @ts-expect-error Read-only API cannot presign uploads.
    readBucket.presignPut("key");
    const writeBucket = yield* WriteBucket(bucket);
    // @ts-expect-error Write client surface excludes reads despite Neon's broader credential scope.
    writeBucket.get("key");
    return { inferredValue, value, rawValue, outputValue };
  });

test.effect(
  "typed object declarations are checked by the workspace compiler",
  () =>
    Effect.sync(() => {
      expect(typeof typeCases).toBe("function");
    }),
  {
    tags: [
      "unit",
      "provider:neon",
      "provider:neon:bucket",
      "provider:neon:object",
      "local",
    ],
  },
);
