import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import { callProbe, dockerAvailable, expectProbe } from "../bindingHost.ts";
import StorageBindingsHost, {
  DeleteAssets,
  GetAssets,
  PutAssets,
  ReadAssets,
  ReadWriteAssets,
  SEED_KEY,
  SEED_TEXT,
  SignAssets,
  WriteAssets,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "StorageBindings");

let baseUrl: string;
let hostAccount: string;
let project: string;
let buckets: {
  read: string;
  write: string;
  readWrite: string;
  get: string;
  put: string;
  delete: string;
  sign: string;
};

/** Roles the host's service account holds on one bucket's IAM policy. */
const bucketRoles = (bucket: string) =>
  storage
    .getIamPolicyBuckets({ bucket, optionsRequestedPolicyVersion: 3 })
    .pipe(
      Effect.map((policy) =>
        (policy.bindings ?? [])
          .filter((binding) =>
            (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
          )
          .map((binding) => binding.role)
          .sort(),
      ),
    );

const objectOf = (bucket: string, object: string) =>
  storage
    .getObjects({ bucket, object })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

describe.skipIf(!dockerAvailable)(
  "Storage Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:storage", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* StorageBindingsHost;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              project: host.project,
              read: (yield* ReadAssets).bucketName,
              write: (yield* WriteAssets).bucketName,
              readWrite: (yield* ReadWriteAssets).bucketName,
              get: (yield* GetAssets).bucketName,
              put: (yield* PutAssets).bucketName,
              delete: (yield* DeleteAssets).bucketName,
              sign: (yield* SignAssets).bucketName,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        project = out.project;
        buckets = {
          read: out.read,
          write: out.write,
          readWrite: out.readWrite,
          get: out.get,
          put: out.put,
          delete: out.delete,
          sign: out.sign,
        };
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("ReadBucket", () => {
      test.provider(
        "head, get and list as the host, with objectViewer on the bucket only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              headName: string;
              headSize: string;
              text: string;
              contentType: string;
              listed: string[];
              missingHead: boolean;
              missingGet: boolean;
            }>(baseUrl, "readBucket");
            expect(out.headName).toEqual(SEED_KEY);
            expect(out.headSize).toEqual(String(SEED_TEXT.length));
            expect(out.text).toEqual(SEED_TEXT);
            expect(out.contentType).toEqual("text/plain");
            expect(out.listed).toEqual([SEED_KEY]);
            expect(out.missingHead).toEqual(true);
            expect(out.missingGet).toEqual(true);

            expect(yield* bucketRoles(buckets.read)).toEqual([
              "roles/storage.objectViewer",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:storage", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("WriteBucket", () => {
      test.provider(
        "put and delete as the host, with objectUser on the bucket only",
        (_stack) =>
          Effect.gen(function* () {
            const put = yield* expectProbe<{ name: string }>(
              baseUrl,
              "writeBucketPut",
            );
            expect(put.name).toEqual("written.txt");
            const written = yield* objectOf(buckets.write, "written.txt");
            expect(written?.size).toEqual(
              String("hello from WriteBucket".length),
            );
            expect(written?.contentType).toEqual("text/plain");
            expect(written?.metadata).toEqual({ source: "write-bucket" });

            const deleted = yield* expectProbe<{ deleted: string }>(
              baseUrl,
              "writeBucketDelete",
            );
            expect(deleted.deleted).toEqual("written.txt");
            expect(yield* objectOf(buckets.write, "written.txt")).toEqual(
              undefined,
            );

            expect(yield* bucketRoles(buckets.write)).toEqual([
              "roles/storage.objectUser",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:storage", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ReadWriteBucket", () => {
      test.provider(
        "put, get, list and delete as the host, with objectUser on the bucket only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              putName: string;
              text: string;
              listed: string[];
            }>(baseUrl, "readWriteBucket");
            expect(out.putName).toEqual("round-trip.txt");
            expect(out.text).toEqual("hello from ReadWriteBucket");
            expect(out.listed).toEqual(["round-trip.txt"]);
            const written = yield* objectOf(
              buckets.readWrite,
              "round-trip.txt",
            );
            expect(written?.size).toEqual(
              String("hello from ReadWriteBucket".length),
            );

            const deleted = yield* expectProbe<{ gone: boolean }>(
              baseUrl,
              "readWriteBucketDelete",
            );
            expect(deleted.gone).toEqual(true);
            expect(
              yield* objectOf(buckets.readWrite, "round-trip.txt"),
            ).toEqual(undefined);

            expect(yield* bucketRoles(buckets.readWrite)).toEqual([
              "roles/storage.objectUser",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:storage", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetObject", () => {
      test.provider(
        "downloads the seeded object as the host, with objectViewer on the bucket only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              text: string;
              contentType: string;
            }>(baseUrl, "getObject");
            expect(out.text).toEqual(SEED_TEXT);
            expect(out.contentType).toEqual("text/plain");

            const missing = yield* callProbe(baseUrl, "getObjectMissing");
            expect(missing.ok ? undefined : missing.error._tag).toEqual(
              "GCP.Storage.ObjectNotFound",
            );

            expect(yield* bucketRoles(buckets.get)).toEqual([
              "roles/storage.objectViewer",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:storage", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("PutObject", () => {
      test.provider(
        "uploads bytes with metadata as the host, with objectUser on the bucket only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              name: string;
              metadata: Record<string, string>;
            }>(baseUrl, "putObject");
            expect(out.name).toEqual("put.bin");
            expect(out.metadata).toEqual({ source: "put-object" });

            const written = yield* objectOf(buckets.put, "put.bin");
            expect(written?.size).toEqual(
              String("hello from PutObject".length),
            );
            expect(written?.contentType).toEqual("application/octet-stream");
            expect(written?.metadata).toEqual({ source: "put-object" });

            expect(yield* bucketRoles(buckets.put)).toEqual([
              "roles/storage.objectUser",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:storage", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("DeleteObject", () => {
      test.provider(
        "deletes the seeded object as the host, with objectUser on the bucket only",
        (_stack) =>
          Effect.gen(function* () {
            const seed = yield* objectOf(buckets.delete, SEED_KEY);
            expect(seed?.name).toEqual(SEED_KEY);

            const out = yield* expectProbe<{ deleted: string }>(
              baseUrl,
              "deleteObject",
            );
            expect(out.deleted).toEqual(SEED_KEY);
            expect(yield* objectOf(buckets.delete, SEED_KEY)).toEqual(
              undefined,
            );

            const missing = yield* callProbe(baseUrl, "deleteObjectMissing");
            expect(missing.ok ? undefined : missing.error._tag).toEqual(
              "NotFound",
            );

            expect(yield* bucketRoles(buckets.delete)).toEqual([
              "roles/storage.objectUser",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:storage", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("SignGetObjectUrl", () => {
      test.provider(
        "mints a V4 URL that downloads without credentials; grants objectViewer on the bucket and tokenCreator on the host's own account",
        (_stack) =>
          Effect.gen(function* () {
            const { url } = yield* expectProbe<{ url: string }>(
              baseUrl,
              "signGetObjectUrl",
            );
            expect(url).toContain(
              `https://storage.googleapis.com/${buckets.sign}/seed/hello.txt?`,
            );
            expect(url).toContain(
              `X-Goog-Credential=${encodeURIComponent(hostAccount)}`,
            );

            // No credentials: the signature alone authorizes the download.
            // The signer's bucket grant may still be propagating.
            const body = yield* HttpClient.get(url).pipe(
              Effect.flatMap((response) =>
                response.status === 200
                  ? response.text
                  : Effect.fail(new Error(`HTTP ${response.status}`)),
              ),
              Effect.retry({
                schedule: Schedule.spaced("5 seconds"),
                times: 24,
              }),
            );
            expect(body).toEqual(SEED_TEXT);

            expect(yield* bucketRoles(buckets.sign)).toEqual([
              "roles/storage.objectViewer",
            ]);
            const accountPolicy =
              yield* iam.getIamPolicyProjectsServiceAccounts({
                resource: `projects/${project}/serviceAccounts/${hostAccount}`,
              });
            expect(
              (accountPolicy.bindings ?? [])
                .filter((binding) =>
                  (binding.members ?? []).includes(
                    `serviceAccount:${hostAccount}`,
                  ),
                )
                .map((binding) => binding.role),
            ).toEqual(["roles/iam.serviceAccountTokenCreator"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:storage", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
