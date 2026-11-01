import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as run from "@distilled.cloud/gcp/run_v2";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Test from "alchemy/Test/Bun";
import { describe, expect } from "bun:test";
import { createHash } from "node:crypto";
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

// The project comes from the same credential the deploy uses.
const currentProject = GCP.GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
  Effect.provide(GCP.fromCredentials().pipe(Layer.provide(GcpHttp))),
);

// Both services are built from `main`, which needs a local image build.
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status ===
  0;

// Kept for the post-destroy checks in `afterAll`.
let deployed:
  | {
      url: string | undefined;
      indexerUrl: string | undefined;
      location: string;
      bucketName: string;
      databaseName: string;
    }
  | undefined;

// Deploy, tests and destroy all sit behind the same Docker guard.
describe.skipIf(!dockerAvailable)("gcp-storage-uploads", () => {
  const stack = beforeAll(
    deploy(Stack).pipe(
      Effect.tap((outputs) =>
        Effect.sync(() => {
          deployed = outputs;
        }),
      ),
    ),
    { timeout: 900_000 },
  );

  const gone = <A, E extends { _tag: string }, R>(
    get: Effect.Effect<A, E, R>,
  ) =>
    get.pipe(
      Effect.as("found" as const),
      Effect.catchIf(
        (error) => error._tag === "NotFound",
        () => Effect.succeed("gone" as const),
      ),
    );

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      yield* destroy(Stack);
      if (deployed === undefined) return;
      const { bucketName, databaseName, url, indexerUrl, location } = deployed;

      // Destroy leaves nothing behind: bucket (and its notification),
      // database, and both services.
      expect(yield* gone(storage.getBuckets({ bucket: bucketName }))).toEqual(
        "gone",
      );
      // A deleted database may linger briefly with `deleteTime` set.
      const database = yield* firestore
        .getProjectsDatabases({ name: databaseName })
        .pipe(
          Effect.map((database) =>
            database.deleteTime === undefined ? "found" : "gone",
          ),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(database).toEqual("gone");
      const project = yield* currentProject;
      const services = yield* run.listProjectsLocationsServices({
        parent: `projects/${project}/locations/${location}`,
      });
      const uris = (services.services ?? []).flatMap((service) => [
        service.uri,
        ...(service.urls ?? []),
      ]);
      expect(uris).not.toContain(url);
      expect(uris).not.toContain(indexerUrl);
    }).pipe(Effect.provide(GcpHttp)),
    { timeout: 600_000 },
  );

  const baseUrlOf = (url: string | undefined) => {
    if (url === undefined) throw new Error("the service has no URL");
    return url.replace(/\/+$/, "");
  };

  const sha256 = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");

  const put = (baseUrl: string, name: string, body: Uint8Array, type: string) =>
    HttpClient.execute(
      HttpClientRequest.put(`${baseUrl}/files/${name}`).pipe(
        HttpClientRequest.bodyUint8Array(body, type),
      ),
    );

  interface FileRecord {
    name: string;
    object: string;
    generation: string;
    size: number;
    contentType: string;
    sha256: string;
    indexedAt: string;
  }

  const listFiles = (baseUrl: string) =>
    Effect.gen(function* () {
      const res = yield* HttpClient.execute(
        HttpClientRequest.get(`${baseUrl}/files`),
      );
      if (res.status !== 200) return [] as FileRecord[];
      return ((yield* res.json) as unknown as { files: FileRecord[] }).files;
    });

  test(
    "serves the health route and rejects bad names",
    Effect.gen(function* () {
      const { url } = yield* stack;
      expect(url).toMatch(/^https:\/\//);
      const baseUrl = baseUrlOf(url);
      const health = yield* getWhenReady(`${baseUrl}/`);
      expect(health.status).toBe(200);

      const bad = yield* put(
        baseUrl,
        encodeURIComponent("../escape"),
        new TextEncoder().encode("nope"),
        "text/plain",
      );
      expect(bad.status).toBe(400);

      const missing = yield* HttpClient.execute(
        HttpClientRequest.get(`${baseUrl}/files/never-uploaded.txt`),
      );
      expect(missing.status).toBe(404);
    }),
    { timeout: 120_000 },
  );

  test(
    "uploads are stored, indexed with their sha256, and deleted",
    Effect.gen(function* () {
      const { url, bucketName, databaseName } = yield* stack;
      const baseUrl = baseUrlOf(url);
      yield* getWhenReady(`${baseUrl}/`);

      const files = [
        {
          name: "hello.txt",
          body: new TextEncoder().encode("Hello, uploads!\n"),
          type: "text/plain",
        },
        {
          name: "random.bin",
          body: crypto.getRandomValues(new Uint8Array(64 * 1024)),
          type: "application/octet-stream",
        },
      ];

      for (const file of files) {
        const res = yield* put(baseUrl, file.name, file.body, file.type);
        expect(res.status).toBe(202);
        expect(yield* res.json).toMatchObject({
          name: file.name,
          object: `uploads/${file.name}`,
          size: file.body.byteLength,
        });

        // The bytes read back through the API are the bytes uploaded.
        const back = yield* HttpClient.execute(
          HttpClientRequest.get(`${baseUrl}/files/${file.name}`),
        );
        expect(back.status).toBe(200);
        expect(back.headers["content-type"]).toContain(file.type);
        expect(new Uint8Array(yield* back.arrayBuffer)).toEqual(file.body);
      }

      // The indexer runs off the bucket notification. A fresh deploy's
      // project-level Firestore grants can take minutes to propagate; until
      // then the push fails and Pub/Sub redelivers.
      const indexed = yield* listFiles(baseUrl).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (records) =>
            files.every((file) =>
              records.some((record) => record.name === file.name),
            ),
          times: 42,
        }),
      );

      for (const file of files) {
        const record = indexed.find((record) => record.name === file.name)!;
        expect(record).toMatchObject({
          object: `uploads/${file.name}`,
          size: file.body.byteLength,
          sha256: sha256(file.body),
        });
        expect(record.contentType).toContain(file.type);
        expect(record.generation).toMatch(/^\d+$/);

        // The record is a real Firestore document.
        const document = yield* firestore
          .getProjectsDatabasesDocuments({
            name: `${databaseName}/documents/files/${file.name}`,
          })
          .pipe(Effect.provide(GcpHttp));
        expect(document.fields?.sha256?.stringValue).toEqual(sha256(file.body));

        // And the generation it indexed is the live object's.
        const object = yield* storage
          .getObjects({ bucket: bucketName, object: `uploads/${file.name}` })
          .pipe(Effect.provide(GcpHttp));
        expect(String(object.generation)).toEqual(record.generation);
      }

      const [deleted] = files;
      const del = yield* HttpClient.execute(
        HttpClientRequest.delete(`${baseUrl}/files/${deleted!.name}`),
      );
      expect(del.status).toBe(204);

      const after = yield* HttpClient.execute(
        HttpClientRequest.get(`${baseUrl}/files/${deleted!.name}`),
      );
      expect(after.status).toBe(404);
      const remaining = yield* listFiles(baseUrl);
      expect(remaining.map((record) => record.name)).toEqual(["random.bin"]);

      expect(
        yield* gone(
          storage
            .getObjects({
              bucket: bucketName,
              object: `uploads/${deleted!.name}`,
            })
            .pipe(Effect.provide(GcpHttp)),
        ),
      ).toEqual("gone");
    }),
    { timeout: 600_000 },
  );
});
