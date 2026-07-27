import * as Lambda from "@/AWS/Lambda";
import * as S3Vectors from "@/AWS/S3Vectors";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "vectors-handler.ts");

export class VectorsTestFunction extends Lambda.Function<Lambda.Function>()(
  "S3VectorsTestFunction",
) {}

export default VectorsTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const bucket = yield* S3Vectors.VectorBucket("VBucket", {});
    const index = yield* S3Vectors.Index("VIndex", {
      vectorBucketName: bucket.vectorBucketName,
      dimension: 4,
      distanceMetric: "cosine",
    });
    // Least-privilege split bindings for writes and reads, plus the
    // ReadWrite client to prove the composed level end-to-end.
    const writer = yield* S3Vectors.VectorsWrite(index);
    const reader = yield* S3Vectors.VectorsRead(index);
    const vectors = yield* S3Vectors.Vectors(index);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/put") {
          yield* writer.put({
            vectors: [
              { key: "a", data: { float32: [1, 0, 0, 0] } },
              { key: "b", data: { float32: [0, 1, 0, 0] } },
              { key: "c", data: { float32: [0.9, 0.1, 0, 0] } },
            ],
          });
          return yield* HttpServerResponse.json({ put: 3 });
        }

        if (request.method === "GET" && pathname === "/query") {
          const result = yield* reader.query({
            topK: 2,
            queryVector: { float32: [1, 0, 0, 0] },
            returnDistance: true,
          });
          return yield* HttpServerResponse.json({
            keys: result.vectors.map((v) => v.key),
            distanceMetric: result.distanceMetric,
          });
        }

        if (request.method === "GET" && pathname === "/get") {
          const result = yield* reader.get({
            keys: ["a"],
            returnData: true,
          });
          return yield* HttpServerResponse.json({
            keys: result.vectors.map((v) => v.key),
          });
        }

        if (request.method === "GET" && pathname === "/list") {
          const result = yield* reader.list({});
          return yield* HttpServerResponse.json({
            keys: result.vectors.map((v) => v.key),
          });
        }

        if (request.method === "GET" && pathname === "/delete") {
          yield* writer.delete({ keys: ["b"] });
          return yield* HttpServerResponse.json({ deleted: "b" });
        }

        if (request.method === "GET" && pathname === "/rw") {
          // Round-trip through the ReadWrite client.
          yield* vectors.put({
            vectors: [{ key: "rw", data: { float32: [0, 0, 1, 0] } }],
          });
          const result = yield* vectors.get({ keys: ["rw"] });
          return yield* HttpServerResponse.json({
            keys: result.vectors.map((v) => v.key),
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
        S3Vectors.VectorsHttp,
        S3Vectors.VectorsReadHttp,
        S3Vectors.VectorsWriteHttp,
      ),
    ),
  ),
);
