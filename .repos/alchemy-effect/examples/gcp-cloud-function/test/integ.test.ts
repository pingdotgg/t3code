import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Test from "alchemy/Test/Bun";
import * as cloudfunctions from "@distilled.cloud/gcp/cloudfunctions_v2";
import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: GCP.providers(),
  state: Alchemy.localState(),
});

// Out-of-band calls to the Google APIs resolve the same stored credentials
// the deploy uses, so the test runs against the configured profile.
const GcpHttp = Layer.mergeAll(
  GCP.GcpAuth,
  GCP.fromAuthProvider(),
  FetchHttpClient.layer,
);

interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { functionName, databaseName } = yield* stack;
    yield* destroy(Stack);

    const fn = yield* cloudfunctions
      .getProjectsLocationsFunctions({ name: functionName })
      .pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        Effect.orDie,
        Effect.provide(GcpHttp),
      );
    expect(fn).toEqual("gone");

    // Firestore soft-deletes: the database either 404s or reports a
    // `deleteTime` until it is purged.
    const db = yield* firestore
      .getProjectsDatabases({ name: databaseName })
      .pipe(
        Effect.map((database) =>
          database.deleteTime === undefined ? "found" : "gone",
        ),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        Effect.orDie,
        Effect.provide(GcpHttp),
      );
    expect(db).toEqual("gone");
  }),
  { timeout: 600_000 },
);

const baseUrlOf = (url: string | undefined) => {
  if (url === undefined) throw new Error("the function has no URL");
  return url.replace(/\/+$/, "");
};

test(
  "creates, reads, lists, and deletes notes over public HTTP",
  Effect.gen(function* () {
    const { url, databaseName } = yield* stack;
    expect(url).toMatch(/^https:\/\//);
    const baseUrl = baseUrlOf(url);

    // Right after a deploy the public invoker grant (403) and the
    // project-level Firestore grant (500) can each take minutes to
    // propagate. Poll the list route until both have landed.
    const ready = yield* HttpClient.execute(
      HttpClientRequest.get(`${baseUrl}/notes`),
    ).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (response) => response.status === 200,
        times: 48,
      }),
    );
    expect(ready.status).toBe(200);

    const unknown = yield* HttpClient.execute(
      HttpClientRequest.get(`${baseUrl}/notes/does-not-exist`),
    );
    expect(unknown.status).toBe(404);

    const created = yield* HttpClient.execute(
      HttpClientRequest.post(`${baseUrl}/notes`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          title: "groceries",
          body: "eggs, milk",
        }),
      ),
    );
    expect(created.status).toBe(201);
    const note = (yield* created.json) as unknown as Note;
    expect(note).toMatchObject({ title: "groceries", body: "eggs, milk" });
    expect(note.id).toMatch(/^[0-9a-f-]{36}$/);

    // The row the function wrote is a real Firestore document.
    const document = yield* firestore
      .getProjectsDatabasesDocuments({
        name: `${databaseName}/documents/notes/${note.id}`,
      })
      .pipe(Effect.orDie, Effect.provide(GcpHttp));
    expect(document.fields?.title?.stringValue).toEqual("groceries");
    expect(document.fields?.body?.stringValue).toEqual("eggs, milk");
    expect(document.fields?.createdAt?.timestampValue).toEqual(
      expect.any(String),
    );

    const read = yield* HttpClient.execute(
      HttpClientRequest.get(`${baseUrl}/notes/${note.id}`),
    );
    expect(read.status).toBe(200);
    expect((yield* read.json) as unknown as Note).toEqual(note);

    const listed = yield* HttpClient.execute(
      HttpClientRequest.get(`${baseUrl}/notes`),
    );
    expect(listed.status).toBe(200);
    const { notes } = (yield* listed.json) as unknown as { notes: Note[] };
    expect(notes.map((n) => n.id)).toContain(note.id);

    const invalid = yield* HttpClient.execute(
      HttpClientRequest.post(`${baseUrl}/notes`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ body: "no title" }),
      ),
    );
    expect(invalid.status).toBe(400);

    const deleted = yield* HttpClient.execute(
      HttpClientRequest.delete(`${baseUrl}/notes/${note.id}`),
    );
    expect(deleted.status).toBe(204);

    const gone = yield* HttpClient.execute(
      HttpClientRequest.get(`${baseUrl}/notes/${note.id}`),
    );
    expect(gone.status).toBe(404);

    const documentGone = yield* firestore
      .getProjectsDatabasesDocuments({
        name: `${databaseName}/documents/notes/${note.id}`,
      })
      .pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        Effect.orDie,
        Effect.provide(GcpHttp),
      );
    expect(documentGone).toEqual("gone");
  }),
  { timeout: 600_000 },
);
