import { expect } from "bun:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Test from "@alchemy.run/test/Bun";
import * as Turso from "@alchemy.run/turso";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";
import type { Note } from "../src/schema.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Turso.providers(), Drizzle.providers()),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const { getWhenReady } = Test;

// A fresh workers.dev route can still 404 on some edges after the first
// successful GET. A 404 means the Worker never ran, so retrying is safe even
// for non-idempotent requests.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      while: (response) => response.status === 404,
      times: 10,
    }),
  );

test(
  "each tenant gets its own database forked from the migrated template",
  Effect.gen(function* () {
    const { url, template } = yield* stack;
    const baseUrl = url.replace(/\/+$/, "");
    // Tenant names are org-wide database names, so derive them from the template.
    const acme = `${template}-acme`.slice(0, 50);
    const globex = `${template}-globex`.slice(0, 50);

    const ready = yield* getWhenReady(`${baseUrl}/tenants`);
    expect(ready.status).toBe(200);

    for (const tenant of [acme, globex]) {
      const created = yield* send(HttpClientRequest.post(`${baseUrl}/tenants/${tenant}`));
      expect(created.status).toBe(200);
    }

    const write = yield* send(
      HttpClientRequest.post(`${baseUrl}/tenants/${acme}/notes`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ body: "hello from acme" }),
      ),
    );
    expect(write.status).toBe(200);

    const acmeNotes = (yield* (yield* send(
      HttpClientRequest.get(`${baseUrl}/tenants/${acme}/notes`),
    )).json) as unknown as { notes: Note[] };
    expect(acmeNotes.notes.map((n) => n.body)).toEqual(["hello from acme"]);

    // globex's database is isolated from acme's.
    const globexNotes = (yield* (yield* send(
      HttpClientRequest.get(`${baseUrl}/tenants/${globex}/notes`),
    )).json) as unknown as { notes: Note[] };
    expect(globexNotes.notes).toEqual([]);

    const listed = (yield* (yield* send(HttpClientRequest.get(`${baseUrl}/tenants`)))
      .json) as unknown as {
      tenants: string[];
    };
    expect(listed.tenants).toEqual(expect.arrayContaining([acme, globex]));
    expect(listed.tenants).not.toContain(template);

    for (const tenant of [acme, globex]) {
      const deleted = yield* send(HttpClientRequest.delete(`${baseUrl}/tenants/${tenant}`));
      expect(deleted.status).toBe(200);
    }
  }),
  { timeout: 180_000 },
);
