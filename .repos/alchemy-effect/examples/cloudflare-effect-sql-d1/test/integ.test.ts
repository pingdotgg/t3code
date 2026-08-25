import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";
import type { User } from "../src/Api.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// Fresh `workers.dev` URLs transiently 404 while the route propagates.
// `Test.getWhenReady` retries until the worker answers.
const { getWhenReady } = Test;

test(
  "worker exposes a URL and database name",
  Effect.gen(function* () {
    const { url, databaseName } = yield* stack;

    expect(url).toBeString();
    expect(databaseName).toBeString();
  }),
);

test(
  "worker exposes user CRUD through @effect/sql-d1",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const baseUrl = url.replace(/\/+$/, "");

    const initialResponse = yield* getWhenReady(baseUrl);
    expect(initialResponse.status).toBe(200);

    const initialBody = (yield* initialResponse.json) as unknown as {
      users: User[];
    };
    expect(Array.isArray(initialBody.users)).toBe(true);

    const createResponse = yield* HttpClient.execute(
      HttpClientRequest.post(baseUrl),
    );
    expect(createResponse.status).toBe(200);

    const { user: createdUser } = (yield* createResponse.json) as unknown as {
      user: User;
    };
    expect(createdUser.id).toBeNumber();
    expect(createdUser.email).toBeString();
    expect(createdUser.name).toBeString();
    expect(createdUser.created_at).toBeNumber();

    const readResponse = yield* HttpClient.get(`${baseUrl}/${createdUser.id}`);
    expect(readResponse.status).toBe(200);
    const readBody = (yield* readResponse.json) as unknown as { user: User };
    expect(readBody.user).toMatchObject({
      id: createdUser.id,
      email: createdUser.email,
      name: createdUser.name,
    });

    const invalidReadResponse = yield* HttpClient.get(`${baseUrl}/not-a-user`);
    expect(invalidReadResponse.status).toBe(400);
    expect(yield* invalidReadResponse.json).toEqual({
      error: "Invalid user ID",
    });

    const methodResponse = yield* HttpClient.execute(
      HttpClientRequest.patch(baseUrl),
    );
    expect(methodResponse.status).toBe(405);
    expect(yield* methodResponse.json).toEqual({
      error: "Method not allowed",
    });

    const deleteResponse = yield* HttpClient.execute(
      HttpClientRequest.delete(`${baseUrl}/${createdUser.id}`),
    );
    expect(deleteResponse.status).toBe(200);
    const deleteBody = (yield* deleteResponse.json) as unknown as {
      user: User;
    };
    expect(deleteBody.user).toMatchObject({ id: createdUser.id });

    const finalResponse = yield* HttpClient.get(baseUrl);
    expect(finalResponse.status).toBe(200);
    const finalBody = (yield* finalResponse.json) as unknown as {
      users: User[];
    };
    expect(finalBody.users.some((user) => user.id === createdUser.id)).toBe(
      false,
    );
  }),
  { timeout: 120_000 },
);
