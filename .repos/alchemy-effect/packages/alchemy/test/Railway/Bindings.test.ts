import { fromCredentials } from "@distilled.cloud/aws/Credentials";
import * as AwsEndpoint from "@distilled.cloud/aws/Endpoint";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as S3 from "@distilled.cloud/aws/s3";
import { CredentialsFromEnv } from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Alchemy from "@/index.ts";
import * as Railway from "@/Railway";
import { RailwayRetryPolicy } from "@/Railway/RetryPolicy.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import BucketApi, {
  Data as BucketData,
  OBJECT_BODY,
  OBJECT_KEY,
} from "./fixtures/bucket-api.ts";
import RedisApi, { Cache, REDIS_VALUE } from "./fixtures/redis-api.ts";
import { Site } from "./fixtures/bindings-shared.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Railway.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const distilled = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        RailwayRetryPolicy,
        CredentialsFromEnv,
        FetchHttpClient.layer,
      ),
    ),
  );

class NotReady extends Data.TaggedError("NotReady")<{
  status: number;
  body?: unknown;
}> {
  override get message() {
    return this.body === undefined
      ? `status ${this.status}`
      : `status ${this.status}: ${JSON.stringify(this.body)}`;
  }
}

const asVariableMap = (value: unknown): Record<string, string> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    }
  }
  return out;
};

const readServiceVariables = (
  projectId: string,
  environmentId: string,
  serviceId: string,
) =>
  railway
    .variables({
      projectId,
      environmentId,
      serviceId,
      unrendered: true,
    })
    .pipe(
      Effect.map(asVariableMap),
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed({} as Record<string, string>),
      ),
    );

const firstCredentials = (
  bucketId: string,
  environmentId: string,
  projectId: string,
) =>
  railway
    .bucketS3Credentials({
      bucketId,
      environmentId,
      projectId,
    })
    .pipe(
      Effect.flatMap((items) => {
        const first = items[0];
        return first !== undefined
          ? Effect.succeed(first)
          : Effect.fail(new Error("missing bucket credentials"));
      }),
      Effect.retry({
        schedule: Schedule.spaced("2 seconds"),
        times: 8,
      }),
    );

const withBucketS3 = <A, E, R>(
  creds: {
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    region: string;
  },
  operation: Effect.Effect<A, E, R>,
) =>
  operation.pipe(
    Effect.provide(
      Layer.mergeAll(
        fromCredentials(
          {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
          },
          creds.region as RegionName,
        ),
        AwsEndpoint.of(creds.endpoint),
      ),
    ),
  );

const Stack = Alchemy.Stack(
  "RailwayBindingsFixture",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const project = yield* Site;
    const cache = yield* Cache;
    const proxy = yield* Railway.TcpProxy("CacheProxy", {
      redis: cache,
      environment: cache,
      applicationPort: Railway.REDIS_PORT,
    });
    const redisApi = yield* RedisApi;
    const bucket = yield* BucketData;
    const bucketApi = yield* BucketApi;
    return {
      redisProjectId: project.projectId,
      redisEnvironmentId: cache.environmentId,
      cacheServiceId: cache.serviceId,
      proxyDomain: proxy.domain,
      proxyPort: proxy.proxyPort,
      redisUrl: redisApi.url,
      redisServiceId: redisApi.serviceId,
      bucketProjectId: project.projectId,
      bucketEnvironmentId: bucket.environmentId,
      bucketId: bucket.bucketId,
      bucketUrl: bucketApi.url,
      bucketServiceId: bucketApi.serviceId,
      mode: "effect" as const,
    };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 3_600_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 3_600_000,
});

const retryTransient = {
  while: (e: { _tag?: string; status?: number }) =>
    e._tag === "NotReady" &&
    (e.status === 0 ||
      e.status === 404 ||
      e.status === 500 ||
      e.status === 502 ||
      e.status === 503),
  schedule: Schedule.exponential("500 millis").pipe(
    Schedule.upTo({ duration: "45 seconds" }),
  ),
  times: 10,
} as const;

const readJson = (
  res: HttpClientResponse.HttpClientResponse,
): Effect.Effect<unknown, NotReady> =>
  res.json.pipe(
    Effect.catch(() => Effect.fail(new NotReady({ status: res.status }))),
    Effect.flatMap((body) =>
      res.status === 200
        ? Effect.succeed(body)
        : Effect.fail(new NotReady({ status: res.status, body })),
    ),
  );

const getJson = (url: string, path: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(`${url}${path}`).pipe(
      Effect.timeoutOrElse({
        duration: "8 seconds",
        orElse: () => Effect.fail(new NotReady({ status: 0 })),
      }),
      Effect.flatMap(readJson),
      Effect.mapError((e) =>
        e instanceof NotReady ? e : new NotReady({ status: 0, body: e }),
      ),
      Effect.retry(retryTransient),
    );
  });

const getText = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.timeoutOrElse({
        duration: "8 seconds",
        orElse: () => Effect.fail(new NotReady({ status: 0 })),
      }),
      Effect.flatMap((res) =>
        res.status === 200
          ? res.text.pipe(
              Effect.mapError(() => new NotReady({ status: res.status })),
            )
          : Effect.fail(new NotReady({ status: res.status })),
      ),
      Effect.mapError((e) =>
        e instanceof NotReady ? e : new NotReady({ status: 0, body: e }),
      ),
      Effect.retry(retryTransient),
    );
  });

describe("Railway Bindings", () => {
  test(
    "fixture is reachable over up.railway.app",
    Effect.gen(function* () {
      const out = yield* stack;
      expect(out.redisUrl).toEqual(expect.any(String));
      expect(out.redisUrl).toContain("up.railway.app");
      expect(out.bucketUrl).toEqual(expect.any(String));
      expect(out.bucketUrl).toContain("up.railway.app");

      if (out.mode === "effect") {
        const redisHealth = (yield* getJson(out.redisUrl!, "/health")) as {
          pong?: boolean;
        };
        expect(redisHealth.pong).toEqual(true);
        const bucketHealth = (yield* getJson(out.bucketUrl!, "/health")) as {
          ok?: boolean;
        };
        expect(bucketHealth.ok).toEqual(true);
      } else {
        const redisBody = yield* getText(out.redisUrl!);
        expect(redisBody.length).toBeGreaterThan(0);
        const bucketBody = yield* getText(out.bucketUrl!);
        expect(bucketBody.length).toBeGreaterThan(0);
      }
    }).pipe(logLevel),
    { timeout: 3_600_000 },
  );

  describe("ReadWriteRedis", () => {
    test(
      "sets and gets a key",
      Effect.gen(function* () {
        const out = yield* stack;
        if (out.mode === "effect") {
          const written = (yield* getJson(out.redisUrl!, "/set")) as {
            ok?: boolean;
          };
          expect(written.ok).toEqual(true);
          const read = (yield* getJson(out.redisUrl!, "/get")) as {
            ok?: boolean;
            value?: string;
          };
          expect(read.ok).toEqual(true);
          expect(read.value).toEqual(REDIS_VALUE);
          return;
        }

        // Public image fallback: docker push is impossible without a
        // registry. ReadWriteRedis still packed REDIS_URL onto the
        // Service; set/get runs over the public TCP proxy.
        const cacheVars = yield* distilled(
          readServiceVariables(
            out.redisProjectId,
            out.redisEnvironmentId,
            out.cacheServiceId,
          ),
        );
        const password = cacheVars[Railway.REDIS_PASSWORD_ENV];
        expect(password !== undefined && password.length > 0).toEqual(true);

        const url = Railway.redisConnectionUrl({
          host: out.proxyDomain,
          port: out.proxyPort,
          password: password!,
        });
        const pong = yield* Railway.runRedisCommand(url, "PING").pipe(
          Effect.retry({
            schedule: Schedule.spaced("4 seconds"),
            times: 10,
          }),
        );
        expect(String(pong).toUpperCase()).toContain("PONG");
        yield* Railway.runRedisCommand(url, "SET", ["marker", REDIS_VALUE]);
        const got = yield* Railway.runRedisCommand(url, "GET", ["marker"]);
        expect(got).toEqual(REDIS_VALUE);
      }).pipe(logLevel),
      { timeout: 3_600_000 },
    );
  });

  describe("PutObject / GetObject", () => {
    test(
      "puts and gets an object",
      Effect.gen(function* () {
        const out = yield* stack;
        if (out.mode === "effect") {
          const put = (yield* getJson(out.bucketUrl!, "/put")) as {
            ok?: boolean;
          };
          expect(put.ok).toEqual(true);
          const got = (yield* getJson(out.bucketUrl!, "/get")) as {
            ok?: boolean;
            text?: string;
          };
          expect(got.ok).toEqual(true);
          expect(got.text).toEqual(OBJECT_BODY);
          return;
        }

        // Public image fallback: docker push is impossible without a
        // registry. PutObject/GetObject still packed AWS_* onto the
        // Service; put/get runs over the S3 API from the test process.
        const vars = yield* distilled(
          readServiceVariables(
            out.bucketProjectId,
            out.bucketEnvironmentId,
            out.bucketServiceId,
          ),
        );
        expect((vars.AWS_ACCESS_KEY_ID ?? "").length).toBeGreaterThan(0);
        expect((vars.BUCKET_NAME ?? "").length).toBeGreaterThan(0);

        const creds = yield* distilled(
          firstCredentials(
            out.bucketId,
            out.bucketEnvironmentId,
            out.bucketProjectId,
          ),
        );
        yield* withBucketS3(
          creds,
          S3.putObject({
            Bucket: creds.bucketName,
            Key: OBJECT_KEY,
            Body: OBJECT_BODY,
            ContentType: "text/plain",
          }),
        );
        const got = yield* withBucketS3(
          creds,
          S3.getObject({
            Bucket: creds.bucketName,
            Key: OBJECT_KEY,
          }),
        );
        const text =
          got.Body === undefined
            ? ""
            : yield* Stream.mkString(Stream.decodeText(got.Body));
        expect(text).toEqual(OBJECT_BODY);
      }).pipe(logLevel),
      { timeout: 3_600_000 },
    );
  });
});
