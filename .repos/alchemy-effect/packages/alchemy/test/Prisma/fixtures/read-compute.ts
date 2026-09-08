import { Compute } from "@/Prisma/Compute.ts";
import { ReadBucket, ReadBucketBinding } from "@/Prisma/ReadBucket.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { TestBucket, TestProject } from "./bucket.ts";
import { readRoutes } from "./read-routes.ts";

/** Read-only access via the native Compute binding (`ReadBucketBinding`). */
export default Compute(
  "PrismaReadBucketCompute",
  Effect.gen(function* () {
    const project = yield* TestProject;
    return {
      project,
      appName: "alchemy-bucket-binding-read",
      main: import.meta.filename,
      port: 8080,
      timeoutSeconds: 240,
      destroyOldDeployment: true,
    };
  }),
  Effect.gen(function* () {
    const bucket = yield* TestBucket;
    const store = yield* ReadBucket(bucket);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const handled = yield* readRoutes(store, url);
        return handled ?? HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(ReadBucketBinding)),
);
