import * as S3 from "@distilled.cloud/aws/s3";
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { getWhenReady } = Test;

class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  body: string;
}> {}

const getBodyWhenReady = (url: string, expected: string) =>
  Effect.gen(function* () {
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const body = yield* res.text;
    if (!body.includes(expected)) {
      return yield* Effect.fail(new AssetNotReady({ body }));
    }
    return body;
  }).pipe(
    Effect.retry({
      while: (error) => error instanceof AssetNotReady,
      schedule: Schedule.min([
        Schedule.exponential("500 millis"),
        Schedule.spaced("3 seconds"),
      ]),
      times: 10,
    }),
  );

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  profile: process.env.ALCHEMY_PROFILE,
  providers: AWS.providers(),
  state: AWS.state(),
});

// Pre-deploy cleanup must not close the suite's shared runtime scope.
const stack = beforeAll(
  Effect.sync(Test.defaultStage).pipe(
    Effect.flatMap((stage) => Alchemy.destroy({ stack: Stack, stage })),
    Effect.andThen(deploy(Stack)),
    Effect.tap(Console.log),
  ),
  {
    timeout: 1_200_000,
  },
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 1_200_000,
});

const base = Effect.map(stack, ({ url }) => {
  if (!url) throw new Error("expected the site to expose a CloudFront url");
  return String(url).replace(/\/+$/, "");
});

test(
  "deploys and exposes a url",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeString();
  }),
  { timeout: 180_000 },
);

test(
  "serves the home page",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(url, "Hello from vinext on AWS!");
    expect(html).toContain("vinext on AWS");
  }),
  { timeout: 180_000 },
);

test(
  "serves the ISR page",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(`${url}/isr`, "ISR");
    expect(html).toContain("revalidate 60s");
  }),
  { timeout: 180_000 },
);

test.provider(
  "persists ISR entries in the S3 cache",
  () =>
    Effect.gen(function* () {
      const { cacheBucketName } = yield* stack;
      if (!cacheBucketName) {
        throw new Error("expected the site to expose its ISR cache bucket");
      }
      const url = yield* base;
      yield* getBodyWhenReady(`${url}/isr`, "ISR");
      const objects = yield* S3.listObjectsV2({
        Bucket: cacheBucketName,
        Prefix: "vinext-cache/",
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          times: 10,
          until: (result) => (result.Contents?.length ?? 0) > 0,
        }),
      );
      expect(
        objects.Contents?.some((object) => object.Key?.includes("isr")),
      ).toBe(true);
    }),
  { timeout: 60_000 },
);

test(
  "serves the dynamic API route",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(`${url}/api/hello?name=Alchemy`);
    expect(res.status).toBe(200);
    const body = yield* res.json;
    expect(body).toEqual({
      name: "Alchemy",
      greeting: "Hello from vinext on AWS!",
    });
  }),
  { timeout: 180_000 },
);

test(
  "serves a static asset from public/",
  Effect.gen(function* () {
    const url = yield* base;
    const body = yield* getBodyWhenReady(`${url}/robots.txt`, "User-agent: *");
    expect(body).toContain("User-agent: *");
  }),
  { timeout: 180_000 },
);
