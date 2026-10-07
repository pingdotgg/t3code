import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import * as Prisma from "alchemy/Prisma";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(
    Cloudflare.providers(),
    Prisma.providers(),
    Neon.providers(),
  ),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// Fresh `workers.dev` URLs transiently 404/5xx while the route and the
// Hyperdrive/Neon bindings settle; getWhenReady retries until the worker
// answers.
const { getWhenReady } = Test;

interface UserRow {
  id: string;
  email: string;
  name: string;
  posts?: unknown[];
}

test(
  "worker exposes a URL, hyperdrive id, and neon branch id",
  Effect.gen(function* () {
    const { url, branchId, hyperdriveId } = yield* stack;

    expect(url).toBeString();
    expect(branchId).toBeString();
    expect(hyperdriveId).toBeString();
  }),
);

test(
  "worker exposes user CRUD through Prisma ORM / Hyperdrive / Neon",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const baseUrl = url.replace(/\/+$/, "");

    const initialResponse = yield* getWhenReady(baseUrl);
    expect(initialResponse.status).toBe(200);
    const initialBody = (yield* initialResponse.json) as unknown as {
      users: UserRow[];
    };
    expect(Array.isArray(initialBody.users)).toBe(true);

    const createResponse = yield* HttpClient.execute(
      HttpClientRequest.post(baseUrl),
    );
    expect(createResponse.status).toBe(200);
    const { user: createdUser } = (yield* createResponse.json) as unknown as {
      user: UserRow;
    };
    expect(createdUser.id).toBeString();
    expect(createdUser.email).toBeString();

    const listedResponse = yield* HttpClient.get(baseUrl);
    const listed = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        users: Schema.Array(Schema.Struct({ id: Schema.String })),
      }),
    )(yield* listedResponse.json);
    expect(listed.users.some((user) => user.id === createdUser.id)).toBe(true);

    const readResponse = yield* HttpClient.get(`${baseUrl}/${createdUser.id}`);
    expect(readResponse.status).toBe(200);
    const readBody = (yield* readResponse.json) as unknown as {
      user: UserRow;
    };
    expect(readBody.user).toMatchObject({
      id: createdUser.id,
      email: createdUser.email,
      posts: [],
    });

    const missingResponse = yield* HttpClient.get(
      `${baseUrl}/00000000-0000-0000-0000-000000000000`,
    );
    expect(missingResponse.status).toBe(200);
    expect(yield* missingResponse.json).toEqual({ user: null });

    const deleteResponse = yield* HttpClient.execute(
      HttpClientRequest.delete(`${baseUrl}/${createdUser.id}`),
    );
    expect(deleteResponse.status).toBe(200);
    const deleteBody = (yield* deleteResponse.json) as unknown as {
      user: UserRow | null;
    };
    expect(deleteBody.user).toMatchObject({ id: createdUser.id });

    const finalResponse = yield* HttpClient.get(baseUrl);
    expect(finalResponse.status).toBe(200);
    const finalBody = (yield* finalResponse.json) as unknown as {
      users: UserRow[];
    };
    expect(finalBody.users.some((user) => user.id === createdUser.id)).toBe(
      false,
    );
  }),
  { timeout: 120_000 },
);
