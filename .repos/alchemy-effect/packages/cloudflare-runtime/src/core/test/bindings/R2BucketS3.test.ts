/**
 * The local S3-compatible endpoint (`/cdn-cgi/local/r2/s3`), adapted from a
 * subset of Miniflare's `test/plugins/r2/s3.spec.ts`. Requests are signed
 * with `aws4fetch` (header auth and presigned query auth); the worker's own
 * binding verifies that S3 writes land in the same bucket.
 */
import { expect, layer } from "@effect/vitest";
import { AwsClient } from "aws4fetch";
import * as Effect from "effect/Effect";
import * as R2Bucket from "../../bindings/r2-bucket/index.ts";
import {
  HEADER_ORIGINAL_URL,
  HEADER_PROXY_SHARED_SECRET,
} from "../../globals/ProxyHeaders.shared.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const CREDENTIALS = {
  accessKeyId: "local-access-key-id",
  secretAccessKey: "local-secret-access-key",
};
const OTHER_CREDENTIALS = {
  accessKeyId: "other-access-key-id",
  secretAccessKey: "other-secret-access-key",
};
const PROXY_SECRET = "s3-proxy-secret";

// `GET /read?key=` reads through the Worker's own binding; `PUT /write?key=`
// writes through it. Everything else answers "user worker".
const SCRIPT = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    const bucket = url.searchParams.get("bucket") === "dev" ? env.DEV : env.BUCKET;
    if (url.pathname === "/read") {
      const object = await bucket.get(key);
      return object === null
        ? new Response("missing", { status: 404 })
        : new Response(object.body, {
            headers: { "content-type": object.httpMetadata?.contentType ?? "" },
          });
    }
    if (url.pathname === "/write") {
      await bucket.put(key, request.body);
      return new Response("ok");
    }
    return new Response("user worker");
  },
};
`;

let workers = 0;
const startS3Worker = Effect.suspend(() =>
  startTestWorker({
    name: `r2-s3-test-${workers++}`,
    compatibilityDate: "2026-03-10",
    compatibilityFlags: [],
    proxySharedSecret: PROXY_SECRET,
    modules: [{ name: "main.js", type: "ESModule", content: SCRIPT }],
    bindings: [
      R2Bucket.local({
        binding: "BUCKET",
        id: "bucket",
        s3Credentials: CREDENTIALS,
      }),
      R2Bucket.local({
        binding: "DEV",
        id: "dev:abc123",
        s3Credentials: CREDENTIALS,
      }),
      R2Bucket.local({
        binding: "OTHER",
        id: "other-bucket",
        s3Credentials: OTHER_CREDENTIALS,
      }),
      R2Bucket.local({ binding: "PRIVATE", id: "private-bucket" }),
    ],
  }),
);

const client = new AwsClient({
  ...CREDENTIALS,
  service: "s3",
  region: "auto",
});

const s3Url = (baseUrl: URL, path: string) =>
  new URL(`${R2Bucket.PATH_R2_S3}${path}`, baseUrl).toString();

/** Header-authenticated S3 request. */
const s3 = (
  baseUrl: URL,
  path: string,
  init: RequestInit = {},
  signer: AwsClient = client,
) =>
  Effect.promise(async () =>
    fetch(await signer.sign(s3Url(baseUrl, path), init)),
  );

/** Mint a presigned URL (query auth). */
const presign = (
  baseUrl: URL,
  path: string,
  method: string,
  expiresIn = 900,
  headers?: Record<string, string>,
) =>
  Effect.promise(async () => {
    const url = new URL(s3Url(baseUrl, path));
    url.searchParams.set("X-Amz-Expires", String(expiresIn));
    const signed = await client.sign(url.toString(), {
      method,
      headers,
      aws: { signQuery: true, allHeaders: headers !== undefined },
    });
    return signed.url;
  });

const text = (response: Response) => Effect.promise(() => response.text());

layer(localRuntimeLayer)("R2 local S3 endpoint", (it) => {
  it.effect("passes non-S3 requests through to the user worker", () =>
    Effect.gen(function* () {
      const worker = yield* startS3Worker;
      expect(yield* worker.fetchText("/")).toBe("user worker");
    }),
  );

  it.effect("round-trips objects with header auth", () =>
    Effect.gen(function* () {
      const { baseUrl, fetchText } = yield* startS3Worker;
      const put = yield* s3(baseUrl, "/bucket/header/hello.txt", {
        method: "PUT",
        body: "hello from s3",
        headers: { "content-type": "text/plain", "x-amz-meta-owner": "me" },
      });
      expect(put.status).toBe(200);
      expect(put.headers.get("etag")).toMatch(/^".+"$/);

      // The Worker's own binding sees the S3 write
      expect(yield* fetchText("/read?key=header/hello.txt")).toBe(
        "hello from s3",
      );

      const get = yield* s3(baseUrl, "/bucket/header/hello.txt");
      expect(get.status).toBe(200);
      expect(get.headers.get("content-type")).toBe("text/plain");
      expect(get.headers.get("x-amz-meta-owner")).toBe("me");
      expect(yield* text(get)).toBe("hello from s3");

      const head = yield* s3(baseUrl, "/bucket/header/hello.txt", {
        method: "HEAD",
      });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe("13");

      const list = yield* s3(baseUrl, "/bucket?list-type=2&prefix=header/");
      expect(list.status).toBe(200);
      const listing = yield* text(list);
      expect(listing).toContain("<Key>header/hello.txt</Key>");
      expect(listing).toContain("<KeyCount>1</KeyCount>");

      const del = yield* s3(baseUrl, "/bucket/header/hello.txt", {
        method: "DELETE",
      });
      expect(del.status).toBe(204);
      const missing = yield* s3(baseUrl, "/bucket/header/hello.txt");
      expect(missing.status).toBe(404);
      expect(yield* text(missing)).toContain("<Code>NoSuchKey</Code>");
    }),
  );

  it.effect("serves presigned PUT and GET URLs", () =>
    Effect.gen(function* () {
      const { baseUrl, fetchText } = yield* startS3Worker;
      const putUrl = yield* presign(
        baseUrl,
        "/bucket/presigned/upload.txt",
        "PUT",
      );
      // An unauthenticated client (e.g. a browser) uploads with just the URL
      const put = yield* Effect.promise(() =>
        fetch(putUrl, { method: "PUT", body: "uploaded via presigned url" }),
      );
      expect(put.status).toBe(200);
      expect(yield* fetchText("/read?key=presigned/upload.txt")).toBe(
        "uploaded via presigned url",
      );

      const getUrl = yield* presign(
        baseUrl,
        "/bucket/presigned/upload.txt",
        "GET",
      );
      const get = yield* Effect.promise(() => fetch(getUrl));
      expect(get.status).toBe(200);
      expect(yield* text(get)).toBe("uploaded via presigned url");
    }),
  );

  it.effect("pins a signed Content-Type on presigned PUTs", () =>
    Effect.gen(function* () {
      const { baseUrl, fetch: workerFetch } = yield* startS3Worker;
      const putUrl = yield* presign(
        baseUrl,
        "/bucket/presigned/typed.json",
        "PUT",
        900,
        { "content-type": "application/json" },
      );
      const wrongType = yield* Effect.promise(() =>
        fetch(putUrl, {
          method: "PUT",
          body: "{}",
          headers: { "content-type": "text/plain" },
        }),
      );
      expect(wrongType.status).toBe(403);
      const ok = yield* Effect.promise(() =>
        fetch(putUrl, {
          method: "PUT",
          body: '{"ok":true}',
          headers: { "content-type": "application/json" },
        }),
      );
      expect(ok.status).toBe(200);
      const read = yield* workerFetch("/read?key=presigned/typed.json");
      expect(read.headers.get("content-type")).toBe("application/json");
    }),
  );

  it.effect("addresses bucket ids containing reserved characters", () =>
    Effect.gen(function* () {
      const { baseUrl, fetchText } = yield* startS3Worker;
      // `dev:`-prefixed ids are how Alchemy names locally-emulated buckets
      const putUrl = yield* presign(baseUrl, "/dev:abc123/a key.txt", "PUT");
      const put = yield* Effect.promise(() =>
        fetch(putUrl, { method: "PUT", body: "colon bucket" }),
      );
      expect(put.status).toBe(200);
      expect(yield* fetchText("/read?bucket=dev&key=a%20key.txt")).toBe(
        "colon bucket",
      );
      const encoded = yield* s3(baseUrl, "/dev%3Aabc123/a%20key.txt");
      expect(encoded.status).toBe(200);
      expect(yield* text(encoded)).toBe("colon bucket");
    }),
  );

  it.effect("rejects unauthenticated, tampered and expired requests", () =>
    Effect.gen(function* () {
      const { baseUrl, fetch: workerFetch } = yield* startS3Worker;
      yield* workerFetch("/write?key=guarded.txt", {
        method: "PUT",
        body: "secret",
      });

      const anonymous = yield* Effect.promise(() =>
        fetch(s3Url(baseUrl, "/bucket/guarded.txt")),
      );
      expect(anonymous.status).toBe(400);

      const getUrl = new URL(
        yield* presign(baseUrl, "/bucket/guarded.txt", "GET"),
      );
      const tampered = new URL(getUrl);
      tampered.pathname = tampered.pathname.replace("guarded", "other");
      const tamperedResponse = yield* Effect.promise(() => fetch(tampered));
      expect(tamperedResponse.status).toBe(403);
      expect(yield* text(tamperedResponse)).toContain(
        "<Code>SignatureDoesNotMatch</Code>",
      );

      // A presigned GET URL does not authorize a PUT
      const wrongMethod = yield* Effect.promise(() =>
        fetch(getUrl, { method: "PUT", body: "overwrite" }),
      );
      expect(wrongMethod.status).toBe(403);

      const expiredUrl = new URL(getUrl);
      expiredUrl.searchParams.set("X-Amz-Date", "20200101T000000Z");
      const expiredCredential = expiredUrl.searchParams
        .get("X-Amz-Credential")!
        .replace(/\/\d{8}\//, "/20200101/");
      expiredUrl.searchParams.set("X-Amz-Credential", expiredCredential);
      const expired = yield* Effect.promise(() => fetch(expiredUrl));
      expect(expired.status).toBe(403);
      expect(yield* text(expired)).toContain("<Code>ExpiredRequest</Code>");

      const tooLong = yield* presign(
        baseUrl,
        "/bucket/guarded.txt",
        "GET",
        604_801,
      );
      const tooLongResponse = yield* Effect.promise(() => fetch(tooLong));
      expect(tooLongResponse.status).toBe(400);
    }),
  );

  it.effect("scopes credentials per bucket", () =>
    Effect.gen(function* () {
      const { baseUrl } = yield* startS3Worker;
      // Credentials for "bucket" don't open "other-bucket"
      const wrongKey = yield* s3(baseUrl, "/other-bucket?list-type=2");
      expect(wrongKey.status).toBe(401);

      const other = new AwsClient({
        ...OTHER_CREDENTIALS,
        service: "s3",
        region: "auto",
      });
      const ok = yield* s3(baseUrl, "/other-bucket?list-type=2", {}, other);
      expect(ok.status).toBe(200);

      // Buckets bound without credentials aren't exposed at all
      const hidden = yield* s3(baseUrl, "/private-bucket?list-type=2");
      expect(hidden.status).toBe(404);
      expect(yield* text(hidden)).toContain("<Code>NoSuchBucket</Code>");

      const buckets = yield* s3(baseUrl, "/");
      const listing = yield* text(buckets);
      expect(listing).toContain("<Name>bucket</Name>");
      expect(listing).toContain("<Name>dev:abc123</Name>");
      expect(listing).not.toContain("other-bucket");
      expect(listing).not.toContain("private-bucket");
    }),
  );

  it.effect("completes multipart uploads", () =>
    Effect.gen(function* () {
      const { baseUrl, fetchText } = yield* startS3Worker;
      const create = yield* s3(baseUrl, "/bucket/multipart.bin?uploads", {
        method: "POST",
      });
      expect(create.status).toBe(200);
      const uploadId = /<UploadId>(.+)<\/UploadId>/.exec(
        yield* text(create),
      )![1]!;

      const part1Body = "a".repeat(5 * 1024 * 1024);
      const part1 = yield* s3(
        baseUrl,
        `/bucket/multipart.bin?partNumber=1&uploadId=${encodeURIComponent(uploadId)}`,
        { method: "PUT", body: part1Body },
      );
      expect(part1.status).toBe(200);
      const part2 = yield* s3(
        baseUrl,
        `/bucket/multipart.bin?partNumber=2&uploadId=${encodeURIComponent(uploadId)}`,
        { method: "PUT", body: "tail" },
      );
      expect(part2.status).toBe(200);

      const complete = yield* s3(
        baseUrl,
        `/bucket/multipart.bin?uploadId=${encodeURIComponent(uploadId)}`,
        {
          method: "POST",
          body: `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${part1.headers.get("etag")}</ETag></Part><Part><PartNumber>2</PartNumber><ETag>${part2.headers.get("etag")}</ETag></Part></CompleteMultipartUpload>`,
        },
      );
      expect(complete.status).toBe(200);
      expect(yield* text(complete)).toContain("CompleteMultipartUploadResult");

      const read = yield* fetchText("/read?key=multipart.bin");
      expect(read.length).toBe(part1Body.length + 4);
      expect(read.endsWith("tail")).toBe(true);
    }),
  );

  it.effect("answers CORS preflights for browser uploads", () =>
    Effect.gen(function* () {
      const { fetch: workerFetch } = yield* startS3Worker;
      const preflight = yield* workerFetch(
        `${R2Bucket.PATH_R2_S3}/bucket/browser.txt`,
        {
          method: "OPTIONS",
          headers: {
            Origin: "http://localhost:5173",
            "Access-Control-Request-Method": "PUT",
            "Access-Control-Request-Headers": "content-type",
          },
        },
      );
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
      expect(preflight.headers.get("access-control-allow-methods")).toContain(
        "PUT",
      );
      expect(preflight.headers.get("access-control-allow-headers")).toBe(
        "content-type",
      );
    }),
  );

  it.effect("verifies signatures against the client-facing proxy URL", () =>
    Effect.gen(function* () {
      const { baseUrl, fetchText } = yield* startS3Worker;
      // A proxy in front of the runtime (Alchemy's dev proxy, Vite) forwards
      // the URL the client used; the signature covers that host
      const publicOrigin = new URL("http://my-app.localhost:4321");
      const putUrl = new URL(
        yield* presign(publicOrigin, "/bucket/proxied.txt", "PUT"),
      );
      const direct = new URL(putUrl.pathname + putUrl.search, baseUrl);
      const unproxied = yield* Effect.promise(() =>
        fetch(direct, { method: "PUT", body: "proxied" }),
      );
      expect(unproxied.status).toBe(403);

      const proxied = yield* Effect.promise(() =>
        fetch(direct, {
          method: "PUT",
          body: "proxied",
          headers: {
            [HEADER_ORIGINAL_URL]: putUrl.toString(),
            [HEADER_PROXY_SHARED_SECRET]: PROXY_SECRET,
          },
        }),
      );
      expect(proxied.status).toBe(200);
      expect(yield* fetchText("/read?key=proxied.txt")).toBe("proxied");
    }),
  );
});
