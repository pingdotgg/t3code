import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";
import type { Post, User } from "../src/schema.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(
    Cloudflare.providers(),
    Drizzle.providers(),
    Neon.providers(),
  ),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "worker exposes a URL, hyperdrive id, and neon branch id",
  Effect.gen(function* () {
    const { url, branchId, hyperdriveId } = yield* stack;

    expect(url).toBeString();
    expect(branchId).toBeString();
    expect(hyperdriveId).toBeString();
  }),
);

// workers.dev subdomain takes a few seconds to propagate after first
// enable; retry until the worker actually answers.
const getOnce = (url: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(url);
    if (response.status === 404) {
      return yield* Effect.fail(new Error("workers.dev not yet propagated"));
    }
    return response;
  }).pipe(
    Effect.tapError((err) =>
      Effect.logError(`${url} not available: ${err.message}`),
    ),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
  );

test(
  "worker exposes user CRUD through Drizzle / Hyperdrive / Neon",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const baseUrl = url.replace(/\/+$/, "");

    const initialResponse = yield* getOnce(baseUrl);
    expect(initialResponse.status).toBe(200);

    const initialBody = (yield* initialResponse.json) as unknown as {
      users: User[];
    };
    expect(Array.isArray(initialBody.users)).toBe(true);

    const createResponse = yield* HttpClient.execute(
      HttpClientRequest.post(baseUrl),
    );
    expect(createResponse.status).toBe(200);

    const createBody = (yield* createResponse.json) as unknown as {
      user: User[];
    };
    expect(createBody.user).toHaveLength(1);

    const [createdUser] = createBody.user;
    expect(createdUser.id).toBeNumber();
    expect(createdUser.email).toBeString();
    expect(createdUser.name).toBeString();
    expect(createdUser.createdAt).toBeString();

    const readResponse = yield* HttpClient.get(`${baseUrl}/${createdUser.id}`);
    expect(readResponse.status).toBe(200);

    const readBody = (yield* readResponse.json) as unknown as {
      user: User & { posts: Post[] };
    };
    expect(readBody.user).toMatchObject({
      id: createdUser.id,
      email: createdUser.email,
      name: createdUser.name,
      posts: [],
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
    expect(deleteBody.user).toMatchObject({
      id: createdUser.id,
      email: createdUser.email,
      name: createdUser.name,
    });

    const finalResponse = yield* HttpClient.get(baseUrl);
    expect(finalResponse.status).toBe(200);
    const finalBody = (yield* finalResponse.json) as unknown as {
      users: User[];
    };
    expect(finalBody.users.some((user) => user.id === createdUser.id)).toBe(
      false,
    );
  }),
  { timeout: 20_000 },
);

test(
  "worker handles 100 sequential queries spaced 100-500ms apart",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const baseUrl = url.replace(/\/+$/, "");

    yield* getOnce(baseUrl);

    const queryOnce = Effect.gen(function* () {
      const response = yield* HttpClient.get(baseUrl);
      expect(response.status).toBe(200);
      const body = (yield* response.json) as unknown as { users: User[] };
      expect(Array.isArray(body.users)).toBe(true);
    });

    const jitter = Effect.sync(
      () => Math.floor(Math.random() * 401) + 100,
    ).pipe(Effect.flatMap((ms) => Effect.sleep(Duration.millis(ms))));

    yield* queryOnce.pipe(
      Effect.zip(jitter),
      Effect.repeat(Schedule.recurs(99)),
    );
  }),
  { timeout: 120_000 },
);
