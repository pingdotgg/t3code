import { Compute } from "@/Prisma/Compute.ts";
import { WriteBucket, WriteBucketBinding } from "@/Prisma/WriteBucket.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { TestBucket, TestProject } from "./bucket.ts";
import { writeRoutes } from "./write-routes.ts";

/** Write-only access via the native Compute binding (`WriteBucketBinding`). */
export default Compute(
  "PrismaWriteBucketCompute",
  Effect.gen(function* () {
    const project = yield* TestProject;
    return {
      project,
      appName: "alchemy-bucket-binding-write",
      main: import.meta.filename,
      port: 8080,
      timeoutSeconds: 240,
      destroyOldDeployment: true,
    };
  }),
  Effect.gen(function* () {
    const bucket = yield* TestBucket;
    const store = yield* WriteBucket(bucket);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const handled = yield* writeRoutes(store, request, url);
        return handled ?? HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(WriteBucketBinding)),
);
