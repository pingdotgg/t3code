import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";
import type { User } from "../src/schema.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
});

const stack = beforeAll(destroy(Stack).pipe(Effect.andThen(deploy(Stack))));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "migrates named objects and keeps their users isolated",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const baseUrl = url.replace(/\/+$/, "");
    const teamA = `${baseUrl}/objects/team-a/users`;
    const teamB = `${baseUrl}/objects/team-b/users`;

    const initial = yield* Test.getWhenReady(teamA);
    expect(initial.status).toBe(200);
    expect(yield* initial.json).toEqual({ users: [] });

    const created = yield* HttpClient.execute(
      HttpClientRequest.post(teamA).pipe(
        HttpClientRequest.bodyJsonUnsafe({ name: "Ada" }),
      ),
    );
    expect(created.status).toBe(201);
    const { user } = (yield* created.json) as { user: User };
    expect(user.name).toBe("Ada");
    expect(user.id).toBeNumber();

    const saved = yield* HttpClient.get(teamA);
    expect(saved.status).toBe(200);
    expect(yield* saved.json).toEqual({ users: [user] });

    const isolated = yield* HttpClient.get(teamB);
    expect(isolated.status).toBe(200);
    expect(yield* isolated.json).toEqual({ users: [] });

    const repeated = yield* HttpClient.get(teamA);
    expect(repeated.status).toBe(200);
    expect(yield* repeated.json).toEqual({ users: [user] });

    const invalid = yield* HttpClient.execute(
      HttpClientRequest.post(teamA).pipe(
        HttpClientRequest.bodyJsonUnsafe({ name: " " }),
      ),
    );
    expect(invalid.status).toBe(400);
  }),
  { timeout: 120_000 },
);
