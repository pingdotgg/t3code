import { bucketAccessKeyLogicalId } from "@/Prisma/BucketBinding";
import type { Bucket as PrismaBucket } from "@/Prisma/Bucket";
import type { ReadBucketClient } from "@/Prisma/ReadBucket";
import type { ReadWriteBucketClient } from "@/Prisma/ReadWriteBucket";
import type { WriteBucketClient } from "@/Prisma/WriteBucket";
import * as Prisma from "@/Prisma";
import * as Test from "@/Test/Alchemy";
import { describe, expect, it } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import Stack from "./fixtures/stack.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

// The access-level split is a type-level contract first: a Read client must
// not offer a way to write, and a Write client must not offer a way to read.
type _ReadHasNoWrites = Expect<
  Equal<Extract<keyof ReadBucketClient, "put" | "delete">, never>
>;
type _WriteHasNoReads = Expect<
  Equal<Extract<keyof WriteBucketClient, "get" | "head" | "list">, never>
>;
type _ReadWriteHasBoth = Expect<
  Equal<Extract<keyof ReadWriteBucketClient, "get" | "put">, "get" | "put">
>;

const bucket = {
  Type: "Prisma.Bucket",
  LogicalId: "Uploads",
  FQN: "Api/Uploads",
} as PrismaBucket;

describe("Prisma bucket binding identity", () => {
  it("derives a stable bucket key logical id per bucket and access level", () => {
    expect(bucketAccessKeyLogicalId(bucket, "Read")).toBe(
      "UploadsReadBucketAccessKey",
    );
    expect(bucketAccessKeyLogicalId(bucket, "Write")).toBe(
      "UploadsWriteBucketAccessKey",
    );
    expect(bucketAccessKeyLogicalId(bucket, "ReadWrite")).toBe(
      "UploadsReadWriteBucketAccessKey",
    );
    // Stable across calls: the deployed bundle has to derive the same id.
    expect(bucketAccessKeyLogicalId(bucket, "Read")).toBe(
      bucketAccessKeyLogicalId({ LogicalId: "Uploads" }, "Read"),
    );
  });
});

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Prisma.providers(),
});

const wantsLive = process.env.ALCHEMY_RUN_LIVE_PRISMA_TESTS === "true";
const hasLiveCredentials =
  !!process.env.PRISMA_SERVICE_TOKEN?.trim() ||
  !!process.env.PRISMA_API_TOKEN?.trim() ||
  process.env.ALCHEMY_RUN_LIVE_PRISMA_WITH_PROFILE === "true";
const runLive = wantsLive && hasLiveCredentials;

// One Prisma Compute deploy alone can take the full 600s Compute.live.test.ts
// budgets for it; this stack deploys three of them plus a project, a bucket
// and its keys.
const HOOK_TIMEOUT = 1_200_000;
const TEST_TIMEOUT = 120_000;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

if (wantsLive && !hasLiveCredentials) {
  test(
    "requires Prisma credentials for the live bucket binding suite",
    Effect.fail(
      new Error(
        [
          "Live Prisma bucket binding suite requested but no credentials are configured.",
          "Set PRISMA_SERVICE_TOKEN, set PRISMA_API_TOKEN, or run `alchemy profile` and add Prisma with `Service Token`,",
          "then rerun this live test with ALCHEMY_RUN_LIVE_PRISMA_TESTS=true.",
        ].join(" "),
      ),
    ),
  );
}

class AppNotReady extends Data.TaggedError("AppNotReady")<{
  status: number;
  body: string;
}> {}

// Bounded spaced schedule — caps total wait so a genuine failure surfaces
// fast instead of an uncapped exponential blowing past the test timeout
// while riding out cold-start propagation.
const ready = Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(30)]);

/** Retry an HTTP call until it returns 200 (rides out the app endpoint's deploy propagation). */
const untilOk = <E, R>(
  eff: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>,
) =>
  eff.pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? Effect.succeed(res)
        : res.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(new AppNotReady({ status: res.status, body })),
            ),
          ),
    ),
    Effect.retry({
      while: (e): e is AppNotReady => e instanceof AppNotReady,
      schedule: ready,
    }),
  );

// Reads assert directly with no retry-until-match: Prisma Object Store is
// Tigris-backed, and same-region requests are read-after-write consistent —
// these apps run in their bucket's region, so a read after a 200 write
// observes the write. `untilOk` above only rides out endpoint readiness.

/** GET `${base}/get?key=` — the stored body plus `contentType` / `metadata`. */
const getObject = (base: string, key: string) =>
  untilOk(HttpClient.get(`${base}/get?key=${encodeURIComponent(key)}`)).pipe(
    Effect.flatMap((res) => res.json),
    Effect.map(
      (body) =>
        body as {
          value: string | null;
          contentType: string | null;
          metadata: Record<string, string> | null;
        },
    ),
  );

/** HEAD-equivalent: `/head` returns `{ exists, size }` (metadata only, no body). */
const headObject = (base: string, key: string) =>
  untilOk(HttpClient.get(`${base}/head?key=${encodeURIComponent(key)}`)).pipe(
    Effect.flatMap((res) => res.json),
    Effect.map((body) => body as { exists: boolean; size: number | null }),
  );

/** `PutOptions` the `/put` route rebuilds from query params. */
interface PutQuery {
  contentType?: string;
  metaKey?: string;
  metaValue?: string;
}

const put = (base: string, key: string, value: string, options?: PutQuery) => {
  const params = new URLSearchParams({ key });
  if (options?.contentType) params.set("contentType", options.contentType);
  if (options?.metaKey) {
    params.set("metaKey", options.metaKey);
    params.set("metaValue", options.metaValue ?? "");
  }
  return untilOk(
    HttpClient.execute(
      HttpClientRequest.put(`${base}/put?${params}`).pipe(
        HttpClientRequest.bodyText(value),
      ),
    ),
  );
};

const del = (base: string, key: string) =>
  untilOk(
    HttpClient.execute(
      HttpClientRequest.make("DELETE")(
        `${base}/del?key=${encodeURIComponent(key)}`,
      ),
    ),
  );

const delMany = (base: string, keys: string[]) =>
  untilOk(
    HttpClient.execute(
      HttpClientRequest.make("DELETE")(
        `${base}/del-many?keys=${encodeURIComponent(keys.join(","))}`,
      ),
    ),
  );

/** One page of `/list`, with the paging fields the client reports. */
const listPage = (
  base: string,
  query: {
    prefix: string;
    delimiter?: string;
    limit?: number;
    cursor?: string;
  },
) => {
  const params = new URLSearchParams({ prefix: query.prefix });
  if (query.delimiter) params.set("delimiter", query.delimiter);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  return untilOk(HttpClient.get(`${base}/list?${params}`)).pipe(
    Effect.flatMap((res) => res.json),
    Effect.map(
      (body) =>
        body as {
          keys: string[];
          delimitedPrefixes: string[];
          truncated: boolean;
          cursor: string | null;
        },
    ),
  );
};

/** Ask the deployed app to mint a presigned URL and hand it back. */
const presign = (
  base: string,
  route: "presign-get" | "presign-put",
  key: string,
  contentType?: string,
) => {
  const params = new URLSearchParams({ key });
  if (contentType) params.set("contentType", contentType);
  return untilOk(HttpClient.get(`${base}/${route}?${params}`)).pipe(
    Effect.flatMap((res) => res.json),
    Effect.map((body) => (body as { url: string }).url),
  );
};

/**
 * Drive every client method through `fetch`: `put` → `get` → `head` →
 * `list` → `delete` (single) → `delete` (batch) → `put` with options →
 * paged/delimited `list` → `presignPut`/`presignGet`, reading back through
 * `readBase` and writing through `writeBase`. All hosts share one bucket, so
 * keys are namespaced by `label` to keep the runs independent.
 */
const exercise = (label: string, writeBase: string, readBase: string) =>
  Effect.gen(function* () {
    const prefix = `${label}/`;
    const k1 = `${prefix}k1`;
    const v1 = `${label}-value`;

    // put + get
    expect((yield* put(writeBase, k1, v1)).status).toBe(200);
    expect((yield* getObject(readBase, k1)).value).toBe(v1);

    // head — metadata reflects the written object
    const meta = yield* headObject(readBase, k1);
    expect(meta.exists).toBe(true);
    expect(meta.size).toBe(new TextEncoder().encode(v1).length);

    // list — the key shows up under its prefix
    expect((yield* listPage(readBase, { prefix })).keys).toContain(k1);

    // delete (single) — head/get then report it gone
    yield* del(writeBase, k1);
    expect((yield* getObject(readBase, k1)).value).toBeNull();
    expect((yield* headObject(readBase, k1)).exists).toBe(false);

    // delete (batch) — write two, delete both in one call
    const k2 = `${prefix}k2`;
    const k3 = `${prefix}k3`;
    yield* put(writeBase, k2, "v2");
    yield* put(writeBase, k3, "v3");
    expect((yield* getObject(readBase, k2)).value).toBe("v2");
    yield* delMany(writeBase, [k2, k3]);
    expect((yield* getObject(readBase, k2)).value).toBeNull();
    expect((yield* getObject(readBase, k3)).value).toBeNull();

    // put options — contentType and user metadata survive the round-trip
    const ok = `${prefix}with-options`;
    yield* put(writeBase, ok, '{"ok":true}', {
      contentType: "application/json",
      metaKey: "owner",
      metaValue: "api",
    });
    const stored = yield* getObject(readBase, ok);
    expect(stored.value).toBe('{"ok":true}');
    expect(stored.contentType).toBe("application/json");
    expect(stored.metadata).toEqual({ owner: "api" });

    // list paging — a small `limit` truncates and hands back a cursor that
    // continues the listing; `delimiter` rolls the nested keys up instead.
    const page = `${prefix}page/`;
    yield* put(writeBase, `${page}a`, "a");
    yield* put(writeBase, `${page}b`, "b");
    yield* put(writeBase, `${page}c`, "c");

    const first = yield* listPage(readBase, { prefix: page, limit: 2 });
    expect(first.keys.length).toBe(2);
    expect(first.truncated).toBe(true);
    expect(typeof first.cursor).toBe("string");
    const second = yield* listPage(readBase, {
      prefix: page,
      cursor: first.cursor ?? undefined,
    });
    expect([...first.keys, ...second.keys]).toContain(`${page}c`);

    const rolled = yield* listPage(readBase, { prefix, delimiter: "/" });
    expect(rolled.delimitedPrefixes).toContain(page);

    // presign — the app mints the URLs, the test uses them with no
    // credentials of its own: upload through the PUT URL, read it back
    // through the GET URL.
    const pk = `${prefix}presigned`;
    const payload = `${label}-presigned-payload`;
    const putUrl = yield* presign(writeBase, "presign-put", pk, "text/plain");
    const uploaded = yield* HttpClient.execute(
      HttpClientRequest.put(putUrl).pipe(
        HttpClientRequest.bodyText(payload, "text/plain"),
      ),
    );
    expect(uploaded.status).toBe(200);

    const getUrl = yield* presign(readBase, "presign-get", pk);
    const downloaded = yield* HttpClient.get(getUrl);
    expect(downloaded.status).toBe(200);
    expect(yield* downloaded.text).toBe(payload);
  });

/**
 * Deploys three Prisma Compute apps that all bind one shared Object Store
 * bucket — read / write / read-write — via {@link Stack}, then drives the
 * binding over `fetch`:
 *
 * - write through the Write app, read it back through the Read app
 *   (cross-app, proving both halves agree on the bucket);
 * - round-trip a key through the ReadWrite app by itself.
 *
 * The stack lives in `fixtures/stack.ts` so it can also be inspected
 * directly, e.g. `alchemy logs --tail --stage test --config ./test/Prisma/fixtures/stack.ts`.
 */
describe.skipIf(!runLive)("Prisma bucket binding over deployed hosts", () => {
  const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
    timeout: HOOK_TIMEOUT,
  });

  test(
    "write + read across separate compute apps",
    Effect.gen(function* () {
      const out = yield* stack;
      yield* exercise("bind", out.write, out.read);
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );

  test(
    "read-write round-trip in one compute app",
    Effect.gen(function* () {
      const out = yield* stack;
      yield* exercise("rw-bind", out.readWrite, out.readWrite);
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );
});
