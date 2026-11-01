import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeIsRepositoryStarred } from "./driver.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

describe("makeIsRepositoryStarred", () => {
  it.effect("is true only when GitHub answers 204 for the repository", () => {
    const paths: Array<string> = [];
    const starred = new Set(["user/starred/pingdotgg/t3code"]);
    const api = Layer.mock(GitHubRest.GitHubRest)({
      rest: (input) => {
        paths.push(input.path);
        return starred.has(input.path)
          ? Effect.succeed({
              status: 204,
              headers: {},
              body: "",
              truncated: false,
              invalidUtf8: false,
            })
          : Effect.fail(
              new GitHubRequestPolicy.GitHubApiNotFoundError({
                host: input.host,
                operation: input.operation,
              }),
            );
      },
    });
    return Effect.gen(function* () {
      const isStarred = yield* makeIsRepositoryStarred;
      assert.isTrue(yield* isStarred("github.com", "pingdotgg/t3code"));
      assert.isFalse(yield* isStarred("github.com", "pingdotgg/uploadthing"));
      assert.isFalse(yield* isStarred("github.com", "pingdotgg/t3code/../../user"));
      assert.deepStrictEqual(paths, [
        "user/starred/pingdotgg/t3code",
        "user/starred/pingdotgg/uploadthing",
      ]);
    }).pipe(Effect.provide(api));
  });
});
