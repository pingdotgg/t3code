import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import { attachBucketSecrets } from "@/Fly/Bucket";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";

const requests: Array<{ method: string; path: string }> = [];
const providers = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return HttpClient.mapRequestEffect(client, (request) =>
      Effect.sync(() => {
        if (request.url.startsWith("https://api.machines.dev/")) {
          requests.push({
            method: request.method,
            path: new URL(request.url).pathname,
          });
        }
        return request;
      }),
    );
  }),
).pipe(Layer.provideMerge(Fly.providers()));

const { test } = Test.make({ providers });

const assertAppGone = (appName: string) =>
  machines.getApp({ app_name: appName }).pipe(
    Effect.as(false),
    Effect.catchTag("NotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (gone) => gone,
      times: 10,
    }),
    Effect.tap((gone) => Effect.sync(() => expect(gone).toBe(true))),
  );

const secretMetadata = (appName: string) =>
  machines
    .listSecrets({ app_name: appName, show_secrets: false })
    .pipe(
      Effect.map((response) =>
        (response.secrets ?? [])
          .map((secret) => ({ name: secret.name, digest: secret.digest }))
          .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
      ),
    );

const scenarios: Array<{
  name: string;
  attachment: boolean;
  env: Record<string, string>;
}> = [
  { name: "missing add-on without credentials", attachment: true, env: {} },
  {
    name: "missing add-on with only an access key and endpoint",
    attachment: true,
    env: {
      AWS_ACCESS_KEY_ID: "unused-negative-test-key",
      AWS_ENDPOINT_URL_S3: "https://fly.storage.tigris.dev",
    },
  },
  {
    name: "missing add-on with credentials but no endpoint",
    attachment: true,
    env: {
      AWS_ACCESS_KEY_ID: "unused-negative-test-key",
      AWS_SECRET_ACCESS_KEY: "unused-negative-test-secret",
    },
  },
  {
    name: "bound-env-only credentials without an endpoint",
    attachment: false,
    env: {
      AWS_ACCESS_KEY_ID: "unused-negative-test-key",
      AWS_SECRET_ACCESS_KEY: "unused-negative-test-secret",
    },
  },
];

for (const scenario of scenarios) {
  test.provider(
    `F12 ${scenario.name} fails before secret writes or candidate creation`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const app = yield* stack.deploy(Fly.App("Site"));
        yield* Effect.gen(function* () {
          const missingName = `${app.appName}-absent-bucket`;
          const before = yield* secretMetadata(app.appName);
          const offset = yield* Effect.sync(() => requests.length);
          const result = yield* stack
            .deploy(
              Effect.gen(function* () {
                const site = yield* Fly.App("Site");
                const service = yield* Fly.Service("Consumer", {
                  app: site,
                  // Attachment validation must fail before image resolution.
                  main: import.meta.url,
                  isExternal: true,
                  services: [],
                  deploy: { strategy: "bluegreen" },
                  checks: { ready: { type: "tcp", port: 3000 } },
                });
                yield* service.bind("BucketAttachment", {
                  bucket: scenario.attachment
                    ? { name: missingName }
                    : undefined,
                  env: { BUCKET_NAME: missingName, ...scenario.env },
                });
                return service;
              }),
            )
            .pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toMatchObject({
              _tag: "Fly.TigrisCredentialsMissing",
            });
          }
          const mutations = yield* Effect.sync(() => {
            const prefix = `/v1/apps/${app.appName}/`;
            return requests
              .slice(offset)
              .filter(
                (request) =>
                  request.method !== "GET" &&
                  (request.path.startsWith(`${prefix}machines`) ||
                    request.path.startsWith(`${prefix}secrets`)),
              );
          });
          expect(mutations).toEqual([]);
          expect(
            yield* machines.listMachines({ app_name: app.appName }),
          ).toEqual([]);
          expect(
            yield* Effect.sync(() =>
              requests
                .slice(offset)
                .some(
                  (request) =>
                    request.method === "GET" &&
                    request.path === `/v1/apps/${app.appName}/machines`,
                ),
            ),
          ).toBe(true);
          expect(yield* secretMetadata(app.appName)).toEqual(before);
        }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));
        yield* assertAppGone(app.appName);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie))),
    {
      tags: [
        "provider:fly",
        "provider:fly:app",
        "provider:fly:bucket",
        "provider:fly:machine",
        "provider:fly:service",
        "live",
      ],
      timeout: 300_000,
    },
  );
}

const credential = (
  value: Redacted.Redacted<string> | undefined,
  field: string,
) =>
  value === undefined
    ? Effect.fail(new Error(`Real Tigris bucket did not return ${field}`))
    : Effect.sync(() => Redacted.value(value));

test.provider(
  "F12 complete real bound credentials survive a missing add-on reference",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          const bucket = yield* Fly.Bucket("Data");
          return { app, bucket };
        }),
      );
      yield* Effect.gen(function* () {
        const env = {
          BUCKET_NAME: created.bucket.name,
          AWS_ACCESS_KEY_ID: yield* credential(
            created.bucket.accessKeyId,
            "access key",
          ),
          AWS_SECRET_ACCESS_KEY: yield* credential(
            created.bucket.secretAccessKey,
            "secret key",
          ),
          AWS_ENDPOINT_URL_S3: yield* credential(
            created.bucket.endpoint,
            "endpoint",
          ),
        };
        const floor = yield* attachBucketSecrets(
          created.app.appName,
          [{ name: "", id: `${created.bucket.addOnId}-absent` }],
          env,
        );
        expect(floor).toEqual(expect.any(Number));
        const fromEnvFloor = yield* attachBucketSecrets(
          created.app.appName,
          [],
          env,
        );
        expect(fromEnvFloor).toEqual(expect.any(Number));
        if (floor !== undefined && fromEnvFloor !== undefined) {
          expect(fromEnvFloor).toBeGreaterThanOrEqual(floor);
        }
        const names = (yield* secretMetadata(created.app.appName)).map(
          (secret) => secret.name,
        );
        for (const name of [...Object.keys(env), "AWS_ENDPOINT_URL"]) {
          expect(names).toContain(name);
        }
        const appRequestCount = Effect.sync(
          () =>
            requests.filter((request) =>
              request.path.startsWith(`/v1/apps/${created.app.appName}/`),
            ).length,
        );
        const beforeNoop = yield* appRequestCount;
        expect(
          yield* attachBucketSecrets(created.app.appName, [], {}),
        ).toBeUndefined();
        expect(yield* appRequestCount).toBe(beforeNoop);
        expect(
          yield* machines.listMachines({ app_name: created.app.appName }),
        ).toEqual([]);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));
      yield* assertAppGone(created.app.appName);
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie))),
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:bucket",
      "provider:fly:machine",
      "live",
    ],
    timeout: 300_000,
  },
);

test.provider(
  "ordinary AWS environment without a Bucket deploys a Service without attachment writes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-fly-ordinary-aws-env-",
      });
      const main = path.join(directory, "main.mjs");
      yield* fs.writeFileString(
        main,
        'if (!process.env.AWS_REGION) throw new Error("missing AWS region");\nsetInterval(() => {}, 1000);\n',
      );
      const app = yield* stack.deploy(Fly.App("Site"));
      const before = yield* secretMetadata(app.appName);
      const environments: Array<Record<string, string>> = [
        { AWS_REGION: "us-east-1" },
        {
          AWS_REGION: "us-east-1",
          AWS_ACCESS_KEY_ID: "ordinary-aws-test-key",
          AWS_SECRET_ACCESS_KEY: "ordinary-aws-test-secret",
        },
      ];
      for (const env of environments) {
        const offset = yield* Effect.sync(() => requests.length);
        expect(
          yield* attachBucketSecrets(app.appName, [], env),
        ).toBeUndefined();
        const service = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* Fly.App("Site");
            return yield* Fly.Service("Consumer", {
              app: site,
              main,
              isExternal: true,
              services: [],
              env,
            });
          }),
        );
        const current = yield* machines.getMachine({
          app_name: app.appName,
          machine_id: service.machineId,
        });
        expect(current.state).toBe("started");
        expect(current.config?.env).toMatchObject(env);
        expect(yield* secretMetadata(app.appName)).toEqual(before);
        const observed = yield* Effect.sync(() =>
          requests
            .slice(offset)
            .filter((request) =>
              request.path.startsWith(`/v1/apps/${app.appName}/`),
            ),
        );
        expect(
          observed.some(
            (request) =>
              request.method === "GET" &&
              request.path ===
                `/v1/apps/${app.appName}/machines/${service.machineId}`,
          ),
        ).toBe(true);
        expect(
          observed.filter(
            (request) =>
              request.method !== "GET" &&
              request.path.startsWith(`/v1/apps/${app.appName}/secrets`),
          ),
        ).toEqual([]);
      }
      yield* stack.destroy();
      yield* assertAppGone(app.appName);
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)), Effect.scoped),
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:bucket",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
    timeout: 600_000,
  },
);
