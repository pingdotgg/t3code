import { Compute } from "@/Prisma/Compute.ts";
import {
  ReadWriteBucket,
  ReadWriteBucketBinding,
} from "@/Prisma/ReadWriteBucket.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { TestBucket, TestProject } from "./bucket.ts";
import { readRoutes } from "./read-routes.ts";
import { writeRoutes } from "./write-routes.ts";

/** Read + write access via the native Compute binding (`ReadWriteBucketBinding`). */
export default Compute(
  "PrismaReadWriteBucketCompute",
  Effect.gen(function* () {
    const project = yield* TestProject;
    return {
      project,
      appName: "alchemy-bucket-binding-readwrite",
      main: import.meta.filename,
      port: 8080,
      timeoutSeconds: 240,
      destroyOldDeployment: true,
    };
  }),
  Effect.gen(function* () {
    const bucket = yield* TestBucket;
    const store = yield* ReadWriteBucket(bucket);
    // A second bind of the same bucket and access level must resolve to the
    // SAME bucket-key logical id (pinned by the identity tests) and reuse
    // that resource; registering a conflicting duplicate would fail the
    // deploy.
    yield* ReadWriteBucket(bucket);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        // The ReadWrite client composes both halves; route to whichever
        // matches so we exercise read *and* write through one client.
        const handled =
          (yield* writeRoutes(store, request, url)) ??
          (yield* readRoutes(store, url));
        return handled ?? HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(ReadWriteBucketBinding)),
);
