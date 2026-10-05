import * as GCP from "@/GCP";
import { decodeFields, encodeFields } from "@/GCP/Firestore/Values.ts";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import FirestoreBindingsHost, {
  DocsDatabase,
  PATCHED,
  ReadOnlyDatabase,
  ReadWriteOnlyDatabase,
  SEEDED_DELETE,
  SEEDED_GET,
  WriteOnlyDatabase,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "FirestoreBindings");

let baseUrl: string;
let hostAccount: string;
let project: string;
let databases: {
  docs: string;
  readOnly: string;
  writeOnly: string;
  readWrite: string;
};

/** Write a document out of band, as the deployer. */
const seed = (
  database: string,
  path: string,
  fields: Record<string, unknown>,
) =>
  firestore.patchProjectsDatabasesDocuments({
    name: `${database}/documents/${path}`,
    body: { fields: encodeFields(fields) },
  });

/** Read a document's fields out of band, `undefined` when it is missing. */
const readOutOfBand = (database: string, path: string) =>
  firestore
    .getProjectsDatabasesDocuments({ name: `${database}/documents/${path}` })
    .pipe(
      Effect.map((document) => decodeFields(document.fields)),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

/**
 * Roles the host holds on the project under the IAM Condition naming only
 * `database` (Firestore has no per-database IAM policy). Also asserts the
 * host holds no unconditioned project role.
 */
const scopedRoles = (database: string) =>
  Effect.gen(function* () {
    const policy = yield* crm.getIamPolicyProjects({
      resource: `projects/${project}`,
      body: { options: { requestedPolicyVersion: 3 } },
    });
    const hostBindings = (policy.bindings ?? []).filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    );
    expect(
      hostBindings.filter((binding) => binding.condition === undefined),
    ).toEqual([]);
    const condition = `resource.name == "${database}" || resource.name.startsWith("${database}/")`;
    return hostBindings
      .filter((binding) => binding.condition?.expression === condition)
      .map((binding) => binding.role)
      .sort();
  });

describe.skipIf(!dockerAvailable || !!process.env.FAST)(
  "Firestore Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:firestore",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* FirestoreBindingsHost;
            const docs = yield* DocsDatabase;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              project: docs.project,
              docs: docs.name,
              readOnly: (yield* ReadOnlyDatabase).name,
              writeOnly: (yield* WriteOnlyDatabase).name,
              readWrite: (yield* ReadWriteOnlyDatabase).name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        project = out.project;
        databases = {
          docs: out.docs,
          readOnly: out.readOnly,
          writeOnly: out.writeOnly,
          readWrite: out.readWrite,
        };
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    const expectDocsGrants = Effect.suspend(() =>
      scopedRoles(databases.docs),
    ).pipe(
      Effect.map((roles) =>
        expect(roles).toEqual([
          "roles/datastore.user",
          "roles/datastore.viewer",
        ]),
      ),
    );

    describe("PatchDocument", () => {
      test.provider(
        "writes a document as the host's service account, scoped to the database",
        (_stack) =>
          Effect.gen(function* () {
            const doc = yield* expectProbe<firestore.Document>(
              baseUrl,
              "patchDocument",
            );
            expect(doc.name).toEqual(`${databases.docs}/documents/${PATCHED}`);
            expect(yield* readOutOfBand(databases.docs, PATCHED)).toEqual({
              name: "Alice",
            });
            yield* expectDocsGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:firestore", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetDocument", () => {
      test.provider(
        "reads a seeded document as the host's service account, scoped to the database",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed(databases.docs, SEEDED_GET, { name: "Seeded" });
            const doc = yield* expectProbe<firestore.Document>(
              baseUrl,
              "getDocument",
            );
            expect(doc.fields?.name?.stringValue).toEqual("Seeded");
            yield* expectDocsGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:firestore", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("DeleteDocument", () => {
      test.provider(
        "deletes a seeded document as the host's service account, scoped to the database",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed(databases.docs, SEEDED_DELETE, { name: "Doomed" });
            yield* expectProbe(baseUrl, "deleteDocument");
            expect(
              yield* readOutOfBand(databases.docs, SEEDED_DELETE),
            ).toBeUndefined();
            yield* expectDocsGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:firestore", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ReadDatabase", () => {
      test.provider(
        "gets, lists and queries seeded documents, granted datastore.viewer under the database condition",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed(databases.readOnly, "things/a", { n: 1, s: "a" });
            yield* seed(databases.readOnly, "things/b", { n: 2, s: "b" });
            const out = yield* expectProbe(baseUrl, "read");
            expect(out).toEqual({
              one: { n: 1, s: "a" },
              missing: true,
              listed: ["a", "b"],
              hasNextPage: true,
              big: [2],
            });
            expect(yield* scopedRoles(databases.readOnly)).toEqual([
              "roles/datastore.viewer",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:firestore", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("WriteDatabase", () => {
      test.provider(
        "creates, updates, sets and deletes documents, granted datastore.user under the database condition",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe(baseUrl, "write");
            expect(out).toEqual({
              created: true,
              conflict: "things/created",
              updated: { n: 1, "odd key": "x" },
              updateMissing: "NotFound",
            });
            expect(
              yield* readOutOfBand(databases.writeOnly, "things/created"),
            ).toEqual({ n: 1, "odd key": "x" });
            expect(
              yield* readOutOfBand(databases.writeOnly, "things/set"),
            ).toEqual({ team: "red" });
            expect(
              yield* readOutOfBand(databases.writeOnly, "things/gone"),
            ).toBeUndefined();
            expect(yield* scopedRoles(databases.writeOnly)).toEqual([
              "roles/datastore.user",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:firestore", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ReadWriteDatabase", () => {
      test.provider(
        "round-trips documents, granted datastore.user under the database condition",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe(baseUrl, "readWrite");
            expect(out).toEqual({
              missing: true,
              b: { team: "blue", n: 3 },
              listed: ["a", "b"],
              red: ["a"],
              afterDelete: true,
            });
            expect(
              yield* readOutOfBand(databases.readWrite, "scores/b"),
            ).toEqual({ team: "blue", n: 3 });
            expect(
              yield* readOutOfBand(databases.readWrite, "scores/a"),
            ).toBeUndefined();
            expect(yield* scopedRoles(databases.readWrite)).toEqual([
              "roles/datastore.user",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:firestore", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
