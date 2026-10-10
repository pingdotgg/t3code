import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Test from "alchemy/Test/Bun";
import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { spawnSync } from "node:child_process";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: GCP.providers(),
  state: Alchemy.localState(),
});

const { getWhenReady } = Test;

// Out-of-band calls to the Google APIs resolve the same stored credentials
// the deploy uses, so the test runs against the configured profile.
const GcpHttp = Layer.mergeAll(
  GCP.GcpAuth,
  GCP.fromAuthProvider(),
  FetchHttpClient.layer,
);

// The service is built from `main`, which needs a local image build.
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status ===
  0;

const API_KEY = "integ-test-key";

// Deploy, tests and destroy all sit behind the same Docker guard.
describe.skipIf(!dockerAvailable)("gcp-cloud-run-api", () => {
  const stack = beforeAll(
    Effect.gen(function* () {
      const outputs = yield* deploy(Stack);
      // The secret is created empty on purpose — the value is an operator
      // step. Add the version the service will read.
      yield* secretmanager
        .addVersionProjectsSecrets({
          parent: outputs.secretName,
          body: { payload: { data: btoa(API_KEY) } },
        })
        .pipe(Effect.orDie, Effect.provide(GcpHttp));
      return outputs;
    }),
    { timeout: 900_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
    timeout: 600_000,
  });

  const baseUrlOf = (url: string | undefined) => {
    if (url === undefined) throw new Error("the service has no URL");
    return url.replace(/\/+$/, "");
  };

  const createLink = (baseUrl: string, target: string, key = API_KEY) =>
    HttpClient.execute(
      HttpClientRequest.post(`${baseUrl}/links`).pipe(
        HttpClientRequest.setHeader("x-api-key", key),
        HttpClientRequest.bodyJsonUnsafe({ url: target }),
      ),
    );

  test(
    "serves the health route on a public Cloud Run URL",
    Effect.gen(function* () {
      const { url } = yield* stack;
      expect(url).toMatch(/^https:\/\//);
      const res = yield* getWhenReady(`${baseUrlOf(url)}/`);
      expect(res.status).toBe(200);
    }),
    { timeout: 120_000 },
  );

  test(
    "rejects a create without the Secret Manager key",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const baseUrl = baseUrlOf(url);
      yield* getWhenReady(`${baseUrl}/`);

      const missing = yield* HttpClient.execute(
        HttpClientRequest.post(`${baseUrl}/links`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ url: "https://example.com" }),
        ),
      );
      expect(missing.status).toBe(401);

      const wrong = yield* createLink(baseUrl, "https://example.com", "nope");
      expect(wrong.status).toBe(401);
    }),
    { timeout: 120_000 },
  );

  test(
    "mints a code, redirects, counts the click, and deletes",
    Effect.gen(function* () {
      const { url, databaseName } = yield* stack;
      const baseUrl = baseUrlOf(url);
      yield* getWhenReady(`${baseUrl}/`);

      const target = "https://alchemy.run/gcp";
      // A fresh deploy's Firestore grant (a project binding under an IAM
      // Condition) can take several minutes to propagate; until then the
      // service answers 500 (Forbidden from Firestore).
      const created = yield* createLink(baseUrl, target).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (response) => response.status !== 500,
          times: 42,
        }),
      );
      expect(created.status).toBe(201);
      const { code, shortUrl } = (yield* created.json) as {
        code: string;
        shortUrl: string;
      };
      expect(code).toMatch(/^[0-9A-Za-z]{7}$/);
      expect(shortUrl).toEqual(`${baseUrl}/l/${code}`);

      // The row the service wrote is a real Firestore document.
      const document = yield* firestore
        .getProjectsDatabasesDocuments({
          name: `${databaseName}/documents/links/${code}`,
        })
        .pipe(Effect.orDie, Effect.provide(GcpHttp));
      expect(document.fields?.url?.stringValue).toEqual(target);

      const before = yield* HttpClient.execute(
        HttpClientRequest.get(`${baseUrl}/links/${code}`),
      );
      expect(before.status).toBe(200);
      expect((yield* before.json) as { clicks: number }).toMatchObject({
        url: target,
        clicks: 0,
      });

      // Inspect the redirect itself instead of following it to the target.
      const redirect = yield* HttpClient.execute(
        HttpClientRequest.get(`${baseUrl}/l/${code}`),
      ).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "manual",
        }),
      );
      expect(redirect.status).toBe(302);
      expect(redirect.headers.location).toEqual(target);

      const after = yield* HttpClient.execute(
        HttpClientRequest.get(`${baseUrl}/links/${code}`),
      );
      expect((yield* after.json) as { clicks: number }).toMatchObject({
        clicks: 1,
      });

      const deleted = yield* HttpClient.execute(
        HttpClientRequest.delete(`${baseUrl}/links/${code}`).pipe(
          HttpClientRequest.setHeader("x-api-key", API_KEY),
        ),
      );
      expect(deleted.status).toBe(204);

      const gone = yield* HttpClient.execute(
        HttpClientRequest.get(`${baseUrl}/links/${code}`),
      );
      expect(gone.status).toBe(404);
    }),
    { timeout: 180_000 },
  );
});
