import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";

import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { selectCredentialRoute } from "./GitHubCredentials.ts";

describe("selectCredentialRoute", () => {
  it("uses the active account when no routing is saved", () => {
    assert.deepStrictEqual(
      selectCredentialRoute(DEFAULT_SERVER_SETTINGS, {
        host: "GitHub.com",
        repositories: [],
      }),
      Result.succeed({ host: "github.com", key: "active:github.com", account: undefined }),
    );
  });

  it("selects defaults and owner overrides", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      githubAccountRouting: {
        "github.com": {
          defaultAccount: { login: "personal", tokenSource: "keyring" },
          ownerOverrides: { acme: { login: "work", tokenSource: "keyring" } },
        },
      },
    };

    const selected = selectCredentialRoute(settings, {
      host: "github.com",
      repositories: ["acme/widget"],
    });

    assert(Result.isSuccess(selected));
    assert.equal(selected.success.account?.login, "work");
  });

  it("rejects a batch that needs different accounts", () => {
    const selected = selectCredentialRoute(
      {
        ...DEFAULT_SERVER_SETTINGS,
        githubAccountRouting: {
          "github.com": {
            defaultAccount: { login: "personal", tokenSource: "keyring" },
            ownerOverrides: { acme: { login: "work", tokenSource: "keyring" } },
          },
        },
      },
      {
        host: "github.com",
        repositories: ["personal/widget", "acme/widget"],
      },
    );

    assert(Result.isFailure(selected));
    assert.deepStrictEqual(selected.failure, {
      _tag: "SelectionConflict",
      repositories: ["personal/widget", "acme/widget"],
    });
  });

  it("scopes the same owner independently per host", () => {
    const selected = selectCredentialRoute(
      {
        ...DEFAULT_SERVER_SETTINGS,
        githubAccountRouting: {
          "github.com": {
            ownerOverrides: { acme: { login: "public-user", tokenSource: "keyring" } },
          },
          "github.example.test": {
            ownerOverrides: { acme: { login: "enterprise-user", tokenSource: "keyring" } },
          },
        },
      },
      { host: "github.example.test", repositories: ["acme/widget"] },
    );

    assert(Result.isSuccess(selected));
    assert.equal(selected.success.account?.login, "enterprise-user");
  });
});
