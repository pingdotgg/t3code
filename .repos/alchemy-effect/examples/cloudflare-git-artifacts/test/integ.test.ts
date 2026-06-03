import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { RepoApi } from "../src/Api.ts";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const repoName = `tutorial-${Date.now().toString(36)}`;

test(
  "repo lifecycle",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpApiClient.make(RepoApi, { baseUrl: url });

    const created = yield* client.repos.createRepo({
      payload: { name: repoName, description: "tutorial repo" },
    });
    expect(created.name).toBe(repoName);
    expect(created.remote).toBeString();
    expect(created.token).toBeString();

    const info = yield* client.repos.getRepo({ params: { name: repoName } });
    expect(info.name).toBe(repoName);
    expect(info.defaultBranch).toBe("main");
    expect(info.metadata?.description).toBe("tutorial repo");
    expect(info.metadata?.stars).toBe(0);

    const token = yield* client.repos.cloneToken({
      params: { name: repoName },
      payload: { scope: "read", ttl: 600 },
    });
    expect(token.plaintext).toBeString();
    expect(token.scope).toBe("read");

    const updated = yield* client.repos.updateRepo({
      params: { name: repoName },
      payload: { description: "now with stars", topics: ["demo", "alchemy"] },
    });
    expect(updated.description).toBe("now with stars");
    expect(updated.topics).toEqual(["demo", "alchemy"]);

    const starred = yield* client.repos.starRepo({
      params: { name: repoName },
    });
    expect(starred.stars).toBe(1);

    yield* client.repos.deleteRepo({ params: { name: repoName } });
  }),
  { timeout: 120_000 },
);
