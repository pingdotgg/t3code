import { it as effectIt } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, type HttpClientRequest, HttpClientResponse, UrlParams } from "effect/http";
import { describe, expect, it } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import * as ManagedProviderProxy from "./ManagedProviderProxy.ts";
import * as ProxyAccounts from "./ProxyAccounts.ts";

const now = DateTime.makeUnsafe("2026-10-30T00:00:00Z");

describe("toProviderProxyAccount", () => {
  it.each([
    [
      "an active account",
      { name: "claude-a.json", provider: "claude", email: "a@example.test", status: "active" },
      { name: "claude-a.json", provider: "claude", email: "a@example.test", state: "active" },
    ],
    [
      "a disabled account",
      { name: "codex-b.json", type: "codex", disabled: true, status: "disabled" },
      { name: "codex-b.json", provider: "codex", state: "disabled" },
    ],
    [
      "a cooling-down account",
      {
        name: "codex-c.json",
        provider: "codex",
        account: "c@example.test",
        status: "error",
        status_message: "quota exhausted",
        unavailable: true,
        next_retry_after: "2026-10-30T02:00:00Z",
      },
      {
        name: "codex-c.json",
        provider: "codex",
        email: "c@example.test",
        state: "cooldown",
        statusMessage: "quota exhausted",
        retryAt: "2026-10-30T02:00:00.000Z",
      },
    ],
    [
      "a failing account whose retry time passed",
      {
        name: "claude-d.json",
        provider: "claude",
        status: "error",
        status_message: "token expired",
        unavailable: true,
        next_retry_after: "2026-10-29T23:00:00Z",
      },
      { name: "claude-d.json", provider: "claude", state: "error", statusMessage: "token expired" },
    ],
  ])("maps %s", (_label, file, account) => {
    expect(ProxyAccounts.toProviderProxyAccount(file, now)).toEqual(account);
  });

  it("skips config-defined API keys, which have no credential file to manage", () => {
    expect(
      ProxyAccounts.toProviderProxyAccount(
        { name: "gemini-api-key", provider: "gemini", runtime_only: true },
        now,
      ),
    ).toBeUndefined();
  });
});

const fullUrl = (request: HttpClientRequest.HttpClientRequest) => {
  const query = UrlParams.toString(request.urlParams);
  return query === "" ? request.url : `${request.url}?${query}`;
};
const bodyText = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

/** A fake management API answering by `METHOD path`; unlisted routes answer 404. */
const managementApi = (
  routes: Record<string, { readonly status?: number; readonly body: unknown }>,
  recorded: Array<Recorded>,
) =>
  HttpClient.make((request) => {
    const url = fullUrl(request);
    recorded.push({
      method: request.method,
      url,
      authorization: request.headers.authorization,
      body: bodyText(request),
    });
    const path = url.replace("http://proxy.test:8317/v0/management/", "");
    const route = routes[`${request.method} ${path}`];
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        route === undefined
          ? Response.json({ error: "not found" }, { status: 404 })
          : Response.json(route.body, { status: route.status ?? 200 }),
      ),
    );
  });

const withProxy = (client: HttpClient.HttpClient) =>
  Effect.provide(
    ProxyAccounts.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({
            providerProxy: {
              host: "external",
              url: "http://proxy.test:8317/v1",
              apiKey: "",
              managementKey: "mgmt-key",
            },
          }),
          ManagedProviderProxy.ManagedProviderProxy.layerTest(),
          Layer.succeed(HttpClient.HttpClient, client),
        ),
      ),
    ),
  );

describe("ProxyAccounts", () => {
  effectIt.effect("times out a proxy that sends headers and then stalls the body", () =>
    Effect.gen(function* () {
      const accounts = yield* ProxyAccounts.ProxyAccounts;
      const removal = yield* accounts
        .removeAccount("claude-a.json")
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("15 seconds");
      expect((yield* Fiber.join(removal)).detail).toBe(
        "The proxy did not answer within 15 seconds.",
      );
    }).pipe(
      withProxy(
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(new ReadableStream({ start() {} }))),
          ),
        ),
      ),
    ),
  );

  effectIt.effect("lists, disables, and removes accounts with the management key", () => {
    const recorded: Array<Recorded> = [];
    return Effect.gen(function* () {
      const accounts = yield* ProxyAccounts.ProxyAccounts;
      const state = yield* accounts.getState;
      expect(state.accounts).toEqual([
        { name: "claude-a.json", provider: "claude", email: "a@example.test", state: "active" },
      ]);
      yield* accounts.setAccountDisabled({ name: "claude-a.json", disabled: true });
      yield* accounts.removeAccount("claude a.json");
      const missing = yield* accounts.removeAccount("gone.json").pipe(Effect.flip);
      expect(missing.detail).toBe("The proxy answered with HTTP 404: auth file not found.");

      expect(recorded.map(({ method, url }) => `${method} ${url}`)).toEqual([
        "GET http://proxy.test:8317/v0/management/auth-files",
        "PATCH http://proxy.test:8317/v0/management/auth-files/status",
        "DELETE http://proxy.test:8317/v0/management/auth-files?name=claude%20a.json",
        "DELETE http://proxy.test:8317/v0/management/auth-files?name=gone.json",
      ]);
      expect(recorded.every((request) => request.authorization === "Bearer mgmt-key")).toBe(true);
      expect(JSON.parse(recorded[1]!.body)).toEqual({ name: "claude-a.json", disabled: true });
    }).pipe(
      withProxy(
        managementApi(
          {
            "GET auth-files": {
              body: {
                files: [
                  { name: "claude-a.json", provider: "claude", email: "a@example.test" },
                  { name: "gemini-key", provider: "gemini", runtime_only: true },
                ],
              },
            },
            "PATCH auth-files/status": { body: { status: "ok" } },
            "DELETE auth-files?name=claude%20a.json": { body: { status: "ok" } },
            "DELETE auth-files?name=gone.json": {
              status: 404,
              body: { error: "auth file not found" },
            },
          },
          recorded,
        ),
      ),
    );
  });

  effectIt.effect(
    "signs in with paste-back when the proxy cannot catch the redirect itself",
    () => {
      const recorded: Array<Recorded> = [];
      return Effect.gen(function* () {
        const accounts = yield* ProxyAccounts.ProxyAccounts;
        const login = yield* accounts.startLogin("claude");
        expect(login).toEqual({ url: "https://claude.ai/oauth/authorize?x=1", state: "abc123" });
        // Clients open this URL, so a proxy can't hand them a non-https link.
        const unsafe = yield* accounts.startLogin("codex").pipe(Effect.flip);
        expect(unsafe._tag).toBe("ProviderProxyError");
        expect(yield* accounts.getLoginStatus("abc123")).toEqual({ status: "wait" });

        const wrongLogin = yield* accounts
          .completeLogin({
            state: "abc123",
            redirectUrl: "http://localhost:54545/callback?code=c&state=other",
          })
          .pipe(Effect.flip);
        expect(wrongLogin._tag).toBe("ProviderProxyError");
        yield* accounts.completeLogin({
          state: "abc123",
          redirectUrl: "http://localhost:54545/callback?code=c&state=abc123",
        });

        expect(recorded.map(({ method, url }) => `${method} ${url}`)).toEqual([
          "GET http://proxy.test:8317/v0/management/anthropic-auth-url",
          "GET http://proxy.test:8317/v0/management/codex-auth-url",
          "GET http://proxy.test:8317/v0/management/get-auth-status?state=abc123",
          "POST http://proxy.test:8317/v0/management/oauth-callback",
        ]);
        expect(JSON.parse(recorded[3]!.body)).toEqual({
          redirect_url: "http://localhost:54545/callback?code=c&state=abc123",
        });
      }).pipe(
        withProxy(
          managementApi(
            {
              "GET anthropic-auth-url": {
                body: {
                  status: "ok",
                  url: "https://claude.ai/oauth/authorize?x=1",
                  state: "abc123",
                },
              },
              "GET codex-auth-url": {
                body: { status: "ok", url: "file:///etc/passwd", state: "def456" },
              },
              "GET get-auth-status?state=abc123": { body: { status: "wait" } },
              "POST oauth-callback": { body: { status: "ok" } },
            },
            recorded,
          ),
        ),
      );
    },
  );
});
