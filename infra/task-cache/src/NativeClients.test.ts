import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NativeClients from "./NativeClients.ts";

const tokenDigest = "210eb3d2c67a7207923e1999751300a87a2dd22839b258b80c3d805a6fe64984";
const auth = (name: string) => ({
  authorization: `Basic ${btoa(`${name}:fixture-token-012345678901234567890123456789`)}`,
});
const key = `ios/development/${"a".repeat(40)}`;
const base = `https://cache.example${NativeClients.routePrefix}${key}`;

function memoryBucket() {
  const objects = new Map<string, { bytes: ArrayBuffer; customMetadata: Record<string, string> }>();
  const uploads = new Map<
    string,
    { key: string; customMetadata: Record<string, string>; parts: Map<number, ArrayBuffer> }
  >();
  const resume = (objectKey: string, uploadId: string) => ({
    uploadPart: async (partNumber: number, body: ReadableStream) => {
      uploads.get(uploadId)!.parts.set(partNumber, await new Response(body).arrayBuffer());
      return { partNumber, etag: `etag-${partNumber}` };
    },
    complete: async (parts: ReadonlyArray<{ partNumber: number }>) => {
      const upload = uploads.get(uploadId)!;
      const chunks = parts.map(({ partNumber }) => upload.parts.get(partNumber)!);
      objects.set(objectKey, {
        bytes: await new Blob(chunks).arrayBuffer(),
        customMetadata: upload.customMetadata,
      });
      uploads.delete(uploadId);
    },
    abort: async () => void uploads.delete(uploadId),
  });
  return {
    head: async (objectKey: string) => (objects.has(objectKey) ? {} : null),
    get: async (objectKey: string) => {
      const object = objects.get(objectKey);
      return object
        ? {
            size: object.bytes.byteLength,
            body: new Blob([object.bytes]).stream(),
            customMetadata: object.customMetadata,
          }
        : null;
    },
    createMultipartUpload: async (
      objectKey: string,
      options: { customMetadata: Record<string, string> },
    ) => {
      const uploadId = `upload/${uploads.size}+`;
      uploads.set(uploadId, {
        key: objectKey,
        customMetadata: options.customMetadata,
        parts: new Map(),
      });
      return { uploadId };
    },
    resumeMultipartUpload: resume,
    uploads,
  };
}

const request = (path: string, init: RequestInit & { name: string }) =>
  Effect.gen(function* () {
    const native = yield* NativeClients.NativeClients;
    return yield* native.handle(
      new Request(`${base}${path}`, {
        ...init,
        headers: { ...auth(init.name), ...init.headers },
      }),
    );
  });

it.effect("serves a writer's multipart upload to readers with its digest", () => {
  const bucket = memoryBucket();
  const bindings = {
    CLIENTS: bucket,
    developerKeys: JSON.stringify({ julius: tokenDigest }),
    readerKeys: JSON.stringify({ "ci-reader": tokenDigest }),
    readLimit: { limit: async () => ({ success: true }) },
    storeLimit: { limit: async () => ({ success: true }) },
  } as unknown as NativeClients.Bindings["Service"];
  const digest = "d".repeat(64);
  return Effect.gen(function* () {
    const denied = yield* request("/uploads", {
      name: "ci-reader",
      method: "POST",
      headers: { "x-t3-digest": digest },
    });
    expect(denied.status).toBe(403);

    const created = yield* request("/uploads", {
      name: "julius",
      method: "POST",
      headers: { "x-t3-digest": digest, "x-t3-build-ms": "540000" },
    });
    const { uploadId } = (yield* Effect.promise(() => created.json())) as { uploadId: string };
    const parts = [];
    for (const [index, chunk] of ["native ", "client"].entries()) {
      const response = yield* request(`/uploads/${encodeURIComponent(uploadId)}/${index + 1}`, {
        name: "julius",
        method: "PUT",
        body: chunk,
        headers: { "content-length": String(chunk.length) },
      });
      const { etag } = (yield* Effect.promise(() => response.json())) as { etag: string };
      parts.push({ partNumber: index + 1, etag });
    }
    const completed = yield* request(`/uploads/${encodeURIComponent(uploadId)}/complete`, {
      name: "julius",
      method: "POST",
      body: JSON.stringify({ parts }),
      headers: { "content-length": String(JSON.stringify({ parts }).length) },
    });
    expect(completed.status).toBe(204);

    const download = yield* request("", { name: "ci-reader", method: "GET" });
    expect(download.status).toBe(200);
    expect(download.headers.get("x-t3-digest")).toBe(digest);
    expect(download.headers.get("x-t3-build-ms")).toBe("540000");
    expect(yield* Effect.promise(() => download.text())).toBe("native client");

    const again = yield* request("/uploads", {
      name: "julius",
      method: "POST",
      headers: { "x-t3-digest": digest },
    });
    expect(yield* Effect.promise(() => again.json())).toEqual({ exists: true });
    expect(bucket.uploads.size).toBe(0);
  }).pipe(
    Effect.provide(
      NativeClients.layer.pipe(Layer.provide(Layer.succeed(NativeClients.Bindings, bindings))),
    ),
  );
});
