import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Test from "alchemy/Test/Bun";
import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import * as kms from "@distilled.cloud/gcp/cloudkms_v1";
import * as run from "@distilled.cloud/gcp/run_v2";
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
describe.skipIf(!dockerAvailable)("gcp-secrets-kms", () => {
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

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const outputs = yield* stack;
      yield* destroy(Stack);
      if (outputs === undefined) return;

      // KMS cannot delete a key for at least a day: destroy releases it.
      const key = yield* kms
        .getProjectsLocationsKeyRingsCryptoKeys({ name: outputs.cryptoKeyName })
        .pipe(Effect.orDie, Effect.provide(GcpHttp));
      expect(Object.keys(key.labels ?? {})).toContain("alchemy-released");
      // Released keys hold no usable key material.
      expect(key.primary?.state).not.toBe("ENABLED");

      const secret = yield* secretmanager
        .getProjectsSecrets({ name: outputs.secretName })
        .pipe(
          Effect.map(() => "present" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.orDie,
          Effect.provide(GcpHttp),
        );
      expect(secret).toBe("gone");

      const service = yield* run
        .getProjectsLocationsServices({ name: outputs.serviceName })
        .pipe(
          Effect.map(() => "present" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.orDie,
          Effect.provide(GcpHttp),
        );
      expect(service).toBe("gone");

      // The image repository the service was built into goes with it. Its
      // id is `{serviceId}-src`, cut to Cloud Run's 49-character limit.
      const serviceId = outputs.serviceName.split("/").pop()!;
      const repositoryId = `${serviceId}-src`.slice(0, 49).replace(/-+$/, "");
      const repository = yield* artifactregistry
        .getProjectsLocationsRepositories({
          name: outputs.serviceName.replace(
            /services\/.*$/,
            `repositories/${repositoryId}`,
          ),
        })
        .pipe(
          Effect.map(() => "present" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.orDie,
          Effect.provide(GcpHttp),
        );
      expect(repository).toBe("gone");
    }),
    { timeout: 600_000 },
  );

  const baseUrlOf = (url: string | undefined) => {
    if (url === undefined) throw new Error("the service has no URL");
    return url.replace(/\/+$/, "");
  };

  /** POST JSON, sending `key` as `x-api-key` unless it is `null`. */
  const post = (url: string, body: unknown, key: string | null = API_KEY) =>
    HttpClient.execute(
      HttpClientRequest.post(url).pipe(
        key === null
          ? (request) => request
          : HttpClientRequest.setHeader("x-api-key", key),
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    );

  test(
    "rejects a missing or wrong API key with 401",
    Effect.gen(function* () {
      const { url } = yield* stack;
      expect(url).toMatch(/^https:\/\//);
      const baseUrl = baseUrlOf(url);
      yield* getWhenReady(`${baseUrl}/`);

      const missing = yield* post(
        `${baseUrl}/encrypt`,
        { plaintext: "hi" },
        null,
      );
      expect(missing.status).toBe(401);

      const wrong = yield* post(
        `${baseUrl}/encrypt`,
        { plaintext: "hi" },
        "no",
      );
      expect(wrong.status).toBe(401);

      const wrongDecrypt = yield* post(
        `${baseUrl}/decrypt`,
        { ciphertext: "AAAA" },
        "integ-test-kez",
      );
      expect(wrongDecrypt.status).toBe(401);
    }),
    { timeout: 120_000 },
  );

  test(
    "encrypts with KMS and decrypts back, in and out of band",
    Effect.gen(function* () {
      const { url, cryptoKeyName } = yield* stack;
      const baseUrl = baseUrlOf(url);
      yield* getWhenReady(`${baseUrl}/`);

      const plaintext = "the eagle lands at midnight";

      // The KMS grants on a fresh service account can take a minute or two
      // to propagate; until then encrypt fails with Forbidden (500).
      const encrypted = yield* post(`${baseUrl}/encrypt`, { plaintext }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (response) => response.status !== 500,
          times: 30,
        }),
      );
      expect(encrypted.status).toBe(200);
      const { ciphertext } = (yield* encrypted.json) as { ciphertext: string };
      expect(ciphertext).toEqual(expect.any(String));
      expect(ciphertext).not.toEqual(plaintext);
      expect(ciphertext).not.toEqual(btoa(plaintext));
      expect(atob(ciphertext)).not.toContain(plaintext);

      const decrypted = yield* post(`${baseUrl}/decrypt`, { ciphertext }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (response) => response.status !== 500,
          times: 30,
        }),
      );
      expect(decrypted.status).toBe(200);
      expect((yield* decrypted.json) as { plaintext: string }).toEqual({
        plaintext,
      });

      // The ciphertext is real KMS output: decrypt it directly with the key.
      const direct = yield* kms
        .decryptProjectsLocationsKeyRingsCryptoKeys({
          name: cryptoKeyName,
          body: { ciphertext },
        })
        .pipe(Effect.orDie, Effect.provide(GcpHttp));
      expect(
        Buffer.from(direct.plaintext ?? "", "base64").toString("utf8"),
      ).toEqual(plaintext);

      // Garbage ciphertext is the caller's error, not a server failure.
      const garbage = yield* post(`${baseUrl}/decrypt`, {
        ciphertext: btoa("not a kms ciphertext"),
      });
      expect(garbage.status).toBe(400);
    }),
    { timeout: 600_000 },
  );
});
