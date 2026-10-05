import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as translate from "@distilled.cloud/gcp/translate_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { location, logLevel, currentParent } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const GLOSSARY_ID = "alctrglos1";

const waitUntilGone = (name: string) =>
  translate.getProjectsLocationsGlossariesGlossaryEntries({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilGlossaryGone = (name: string) =>
  translate.getProjectsLocationsGlossaries({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const uploadObject = (bucketName: string, object: string, body: string) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const creds = yield* credentials;
    const client = yield* HttpClient.HttpClient;
    const bytes = yield* Effect.sync(() => new TextEncoder().encode(body));
    const url =
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucketName)}/o` +
      `?uploadType=media&name=${encodeURIComponent(object)}`;
    const response = yield* client.execute(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeader(
          "Authorization",
          `Bearer ${Redacted.value(creds.accessToken)}`,
        ),
        HttpClientRequest.bodyUint8Array(bytes, "text/tab-separated-values"),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(
        Effect.catch(() => Effect.succeed("")),
      );
      return yield* Effect.fail(
        new Error(`object upload failed: ${response.status} ${text}`),
      );
    }
  });

const glossaryNameFromOperation = (operation: translate.Operation) => {
  const response = operation.response ?? {};
  const name = response.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
};

const createGlossary = (glossaryId: string, inputUri?: string) =>
  Effect.gen(function* () {
    const parent = yield* currentParent;
    const name = `${parent}/glossaries/${glossaryId}`;
    const existing = yield* translate
      .getProjectsLocationsGlossaries({ name })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (existing !== undefined) return existing;
    const operation = yield* translate
      .createProjectsLocationsGlossaries({
        parent,
        body: {
          name,
          languagePair: {
            sourceLanguageCode: "en",
            targetLanguageCode: "es",
          },
          ...(inputUri ? { inputConfig: { gcsSource: { inputUri } } } : {}),
        },
      })
      .pipe(
        Effect.catchTag("Conflict", () =>
          Effect.succeed({ name, done: true } as translate.Operation),
        ),
      );
    const done = yield* GCP.Translate.waitForOperation(operation);
    const fromOperation = glossaryNameFromOperation(done);
    if (fromOperation !== undefined) return fromOperation;
    return yield* translate.getProjectsLocationsGlossaries({ name });
  });

const deleteGlossary = (name: string) =>
  translate.deleteProjectsLocationsGlossaries({ name }).pipe(
    Effect.flatMap((operation) =>
      GCP.Translate.waitForOperation(operation, { notFoundOk: true }),
    ),
    Effect.catchTag("NotFound", () => Effect.void),
  );

test.provider(
  "getProjectsLocationsGlossariesGlossaryEntries on a missing entry fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const parent = yield* currentParent;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        translate.getProjectsLocationsGlossariesGlossaryEntries({
          name: `${parent}/glossaries/alchemy-missing/glossaryEntries/123`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:translate", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a glossary entry",
  (stack) =>
    Effect.gen(function* () {
      const parent = yield* currentParent;
      yield* stack.destroy();

      const bucket = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Storage.Bucket("GlossarySrc", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
        }),
      );
      yield* uploadObject(bucket.bucketName, "glossary.tsv", "hello\thola\n");

      const glossary = yield* createGlossary(
        GLOSSARY_ID,
        `gs://${bucket.bucketName}/glossary.tsv`,
      );
      const glossaryName =
        typeof glossary === "string"
          ? glossary
          : (glossary.name ?? `${parent}/glossaries/${GLOSSARY_ID}`);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const nextBucket = yield* GCP.Storage.Bucket("GlossarySrc", {
            bucketName: bucket.bucketName,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const entry = yield* GCP.Translate.GlossariesGlossaryEntry("Hello", {
            parent: glossaryName,
            location,
            description: "greeting",
            termsPair: {
              sourceTerm: { languageCode: "en", text: "hello" },
              targetTerm: { languageCode: "es", text: "hola" },
            },
          });
          return { bucket: nextBucket, entry };
        }),
      );

      expect(created.entry.name).toContain("/glossaryEntries/");
      expect(created.entry.parent).toEqual(glossaryName);
      expect(created.entry.description).toEqual("greeting");
      expect(created.entry.termsPair?.sourceTerm?.text).toEqual("hello");
      expect(created.entry.termsPair?.targetTerm?.text).toEqual("hola");

      const fetched =
        yield* translate.getProjectsLocationsGlossariesGlossaryEntries({
          name: created.entry.name,
        });
      expect(fetched.name).toEqual(created.entry.name);
      expect(fetched.description).toEqual("greeting");
      expect(fetched.termsPair?.targetTerm?.text).toEqual("hola");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const nextBucket = yield* GCP.Storage.Bucket("GlossarySrc", {
            bucketName: bucket.bucketName,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const entry = yield* GCP.Translate.GlossariesGlossaryEntry("Hello", {
            parent: glossaryName,
            location,
            glossaryEntryId: created.entry.glossaryEntryId,
            description: "greeting",
            termsPair: {
              sourceTerm: { languageCode: "en", text: "hello" },
              targetTerm: { languageCode: "es", text: "buenas" },
            },
          });
          return { bucket: nextBucket, entry };
        }),
      );

      expect(updated.entry.name).toEqual(created.entry.name);
      expect(updated.entry.termsPair?.targetTerm?.text).toEqual("buenas");

      const patched =
        yield* translate.getProjectsLocationsGlossariesGlossaryEntries({
          name: created.entry.name,
        });
      expect(patched.termsPair?.targetTerm?.text).toEqual("buenas");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.entry.name);
      expect(gone).toEqual("gone");

      yield* deleteGlossary(glossaryName);
      const glossaryGone = yield* waitUntilGlossaryGone(glossaryName);
      expect(glossaryGone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:translate", "live"],
    timeout: 120_000,
  },
);
