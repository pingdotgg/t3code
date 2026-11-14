import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as NodeAssert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { readOpenCodeUsageLimits } from "./usageLimits.ts";

const plusUsage = {
  plan_type: "plus",
  rate_limit: {
    primary_window: {
      used_percent: 12,
      reset_at: 1_784_000_000,
      limit_window_seconds: 18_000,
    },
    secondary_window: {
      used_percent: 47,
      reset_at: 1_784_500_000,
      limit_window_seconds: 604_800,
    },
  },
};

const accessToken = (claims: unknown) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

const signedIn = accessToken({
  email: "ada@example.com",
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "plus" },
});

it.effect("reads ChatGPT windows from an OpenCode login the same way Codex does", () =>
  Effect.gen(function* () {
    const headers: Array<readonly [string, string | undefined]> = [];
    const read = yield* readOpenCodeUsageLimits({
      enabled: true,
      serverUrl: "",
      environment: {
        OPENCODE_AUTH_CONTENT: JSON.stringify({
          openai: {
            type: "oauth",
            access: signedIn,
            refresh: "refresh-token",
            expires: 1_900_000_000_000,
            accountId: "acct-1",
          },
        }),
      },
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: () => Effect.die("inline credentials must bypass disk"),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          headers.push([request.url, request.headers.authorization]);
          NodeAssert.equal(request.url, "https://chatgpt.com/backend-api/wham/usage");
          NodeAssert.equal(request.headers.authorization, `Bearer ${signedIn}`);
          NodeAssert.equal(request.headers["chatgpt-account-id"], "acct-1");
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(plusUsage)));
        }),
      ),
      Effect.provide(NodeServices.layer),
    );
    NodeAssert.deepEqual(
      headers.map(([url]) => url),
      ["https://chatgpt.com/backend-api/wham/usage"],
    );
    NodeAssert.equal(read.identity?.email, "ada@example.com");
    NodeAssert.equal(read.identity?.plan, "ChatGPT Plus Subscription");
    NodeAssert.equal(read.identity?.workspaceId, "acct-1");
    NodeAssert.equal(
      read.limits.credentialFingerprint,
      "63288efe99483306f34a908ba05783703b9ddcdbd8fd5acdaeefcf3485da3c83",
    );
    NodeAssert.deepEqual(read.limits.windows, [
      {
        id: "primary",
        kind: "session",
        label: "Session",
        usedPercent: 12,
        windowDurationMins: 300,
        resetsAt: "2026-07-14T03:33:20.000Z",
      },
      {
        id: "secondary",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 47,
        windowDurationMins: 10_080,
        resetsAt: "2026-07-19T22:26:40.000Z",
      },
    ]);
  }),
);

it.effect("refreshes an expired ChatGPT session and writes the rotated token back", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dataHome = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${dataHome}/opencode`);
    const authPath = `${dataHome}/opencode/auth.json`;
    yield* fs.writeFileString(
      authPath,
      JSON.stringify({
        anthropic: { type: "api", key: "keep-me" },
        openai: { type: "oauth", access: "expired", refresh: "old-refresh", expires: 0 },
      }),
    );
    const urls: string[] = [];
    const read = yield* readOpenCodeUsageLimits({
      enabled: true,
      serverUrl: "",
      environment: { XDG_DATA_HOME: dataHome },
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          urls.push(request.url);
          if (request.url === "https://auth.openai.com/oauth/token") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  access_token: signedIn,
                  refresh_token: "new-refresh",
                  expires_in: 3600,
                }),
              ),
            );
          }
          NodeAssert.equal(request.headers.authorization, `Bearer ${signedIn}`);
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(plusUsage)));
        }),
      ),
    );
    NodeAssert.deepEqual(urls, [
      "https://auth.openai.com/oauth/token",
      "https://chatgpt.com/backend-api/wham/usage",
    ]);
    NodeAssert.equal(read.limits.windows[0]?.usedPercent, 12);
    const stored = JSON.parse(yield* fs.readFileString(authPath)) as {
      anthropic: { key: string };
      openai: { access: string; refresh: string; accountId: string };
    };
    NodeAssert.equal(stored.anthropic.key, "keep-me");
    NodeAssert.equal(stored.openai.access, signedIn);
    NodeAssert.equal(stored.openai.refresh, "new-refresh");
    NodeAssert.equal(stored.openai.accountId, "acct-1");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("prefers the selected OpenCode 2 ChatGPT credential over auth.json", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dataHome = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${dataHome}/opencode`);
    yield* fs.writeFileString(
      `${dataHome}/opencode/auth.json`,
      JSON.stringify({
        openai: { type: "oauth", access: "file-token", refresh: "file-refresh", expires: 1 },
      }),
    );
    const database = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(`${dataHome}/opencode/opencode.db`)),
      (database) => Effect.sync(() => database.close()),
    );
    database.exec(
      "CREATE TABLE credential (id text PRIMARY KEY, integration_id text, value text, active integer, time_created integer, time_updated integer)",
    );
    database.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, ?, ?)").run(
      "cred_openai",
      "openai",
      JSON.stringify({
        type: "oauth",
        access: "db-token",
        refresh: "db-refresh",
        expires: 1_900_000_000_000,
        accountId: "acct-db",
      }),
      1,
      1,
      1,
    );
    const authorizations: string[] = [];
    const read = yield* readOpenCodeUsageLimits({
      enabled: true,
      serverUrl: "",
      environment: { XDG_DATA_HOME: dataHome },
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          authorizations.push(request.headers.authorization ?? "");
          NodeAssert.equal(request.headers["chatgpt-account-id"], "acct-db");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                plan_type: "free",
                rate_limit: { primary_window: { used_percent: 80 } },
              }),
            ),
          );
        }),
      ),
    );
    NodeAssert.deepEqual(authorizations, ["Bearer db-token"]);
    NodeAssert.deepEqual(read.limits.windows, [
      {
        id: "primary",
        kind: "monthly",
        label: "Monthly",
        usedPercent: 80,
        windowDurationMins: 43_200,
      },
    ]);
    NodeAssert.equal(read.identity?.plan, "ChatGPT Free Subscription");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not report ChatGPT limits for an OpenAI API key", () =>
  Effect.gen(function* () {
    const read = yield* readOpenCodeUsageLimits({
      enabled: true,
      serverUrl: "",
      environment: {
        OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: "api", key: "sk-test" } }),
      },
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("an API key has no subscription usage")),
      ),
      Effect.provide(NodeServices.layer),
    );
    NodeAssert.equal(read.limits.unavailable?.reason, "unsupported");
    NodeAssert.equal(read.identity, undefined);
  }),
);
