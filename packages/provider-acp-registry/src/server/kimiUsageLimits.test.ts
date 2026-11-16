// @effect-diagnostics-next-line nodeBuiltinImport:off -- A loopback fixture verifies redirect handling by the real fetch client.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import {
  kimiApiBaseUrl,
  kimiCliCandidates,
  kimiUsageWindows,
  makeKimiUsageProbe,
  readKimiManagedProviderConfig,
  resolveKimiCodeAuthTarget,
} from "./kimiUsageLimits.ts";

const NOW_SECONDS = 1_800_000_000;
const GLOBAL_CONFIG = `default_model = "kimi-code/kimi-for-coding"

[providers."managed:kimi-code"]
type = "kimi"
api_key = ""
base_url = "https://api.kimi.ai/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-0e4f99c69cc27850"
oauth_host = "https://auth.kimi.ai"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
`;
// Captured from GET https://api.kimi.ai/coding/v1/usages; this account has no weekly quota.
const USAGES = {
  limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" } }],
  usages: {
    limit_5h: { used_ratio: 0.0748, reset_time: "2026-11-15T22:52:15Z" },
    limit_month_total: { used_ratio: 0.3252, reset_time: "2026-12-07T00:00:00Z" },
    limit_month_code: { used_ratio: "0.0605", reset_time: "2026-12-07T00:00:00Z" },
  },
};

const layer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

type Respond = (
  url: string,
) => { readonly status: number; readonly body?: unknown } | "fail" | undefined;

const fixture = Effect.fn("KimiUsageTest.fixture")(function* (options: {
  readonly token?: Record<string, unknown>;
  readonly config?: string;
  readonly legacyToken?: Record<string, unknown>;
  readonly candidates?: ReadonlyArray<"kimi-code" | "kimi-legacy">;
  readonly environment?: Record<string, string>;
  readonly allowLoopbackHttp?: boolean;
  readonly respond?: Respond;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* TestClock.setTime(NOW_SECONDS * 1000);
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "kimi-usage-" });
  const kimiHome = path.join(root, "kimi-code");
  const shareDir = path.join(root, "kimi");
  const slot = "kimi-code-env-0e4f99c69cc27850";
  const credentialsDir = path.join(kimiHome, "credentials");
  const tokenPath = path.join(credentialsDir, `${slot}.json`);
  yield* fs.makeDirectory(credentialsDir, { recursive: true });
  yield* fs.writeFileString(path.join(kimiHome, "config.toml"), options.config ?? GLOBAL_CONFIG);
  if (options.token) yield* fs.writeFileString(tokenPath, JSON.stringify(options.token));
  if (options.legacyToken) {
    yield* fs.makeDirectory(path.join(shareDir, "credentials"), { recursive: true });
    yield* fs.writeFileString(
      path.join(shareDir, "credentials", "kimi-code.json"),
      JSON.stringify(options.legacyToken),
    );
  }
  const requests: Array<{
    url: string;
    method: string;
    authorization?: string;
    redirect?: string;
  }> = [];
  const http = HttpClient.make((request, _url, _signal, fiber) =>
    Effect.suspend(() => {
      const authorization = request.headers.authorization;
      const redirect = Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect;
      requests.push({
        url: request.url,
        method: request.method,
        ...(authorization === undefined ? {} : { authorization }),
        ...(redirect === undefined ? {} : { redirect }),
      });
      const answer =
        options.respond?.(request.url) ??
        (request.url.endsWith("/me")
          ? { status: 200, body: { user_id: "user-1" } }
          : { status: 200, body: USAGES });
      if (answer === "fail") {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "offline" }),
          }),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          answer.body === undefined
            ? new Response(null, { status: answer.status })
            : Response.json(answer.body, { status: answer.status }),
        ),
      );
    }),
  );
  const probe = yield* makeKimiUsageProbe({
    candidates: options.candidates ?? ["kimi-code"],
    environment: {
      KIMI_CODE_HOME: kimiHome,
      KIMI_SHARE_DIR: shareDir,
      HOME: root,
      ...options.environment,
    },
    ...(options.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}),
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
  const listHome = fs
    .readDirectory(kimiHome, { recursive: true })
    .pipe(Effect.map((entries) => entries.toSorted()));
  return { probe, requests, tokenPath, credentialsDir, kimiHome, listHome };
});

const validToken = {
  access_token: "access-current",
  refresh_token: "refresh-current",
  expires_at: NOW_SECONDS + 600,
  expires_in: 900,
  scope: "kimi-code",
  token_type: "Bearer",
};
const expiredToken = { ...validToken, expires_at: NOW_SECONDS - 10 };
const EXPIRED_MESSAGE =
  "Kimi's sign-in expired at 2027-01-15T07:59:50.000Z. Kimi renews it while you use it: use Kimi once, then refresh provider status.";

describe("Kimi subscription limits", () => {
  it("recognizes registry and local Kimi agents only", () => {
    expect(
      kimiCliCandidates({
        source: "registry",
        agentId: "kimi-code",
        commandPath: "",
        commandArgs: [],
      }),
    ).toEqual(["kimi-code"]);
    expect(
      kimiCliCandidates({ source: "registry", agentId: "kimi", commandPath: "", commandArgs: [] }),
    ).toEqual(["kimi-legacy"]);
    expect(
      kimiCliCandidates({
        source: "local",
        agentId: "",
        commandPath: "/opt/homebrew/bin/kimi",
        commandArgs: ["acp"],
      }),
    ).toEqual(["kimi-code", "kimi-legacy"]);
    expect(
      kimiCliCandidates({
        source: "local",
        agentId: "",
        commandPath: "C:\\bin\\kimi.exe",
        commandArgs: [],
      }),
    ).toEqual(["kimi-code", "kimi-legacy"]);
    expect(
      kimiCliCandidates({
        source: "local",
        agentId: "",
        commandPath: "npx",
        commandArgs: ["-y", "@moonshot-ai/kimi-code@2.6.2", "acp"],
      }),
    ).toEqual(["kimi-code"]);
    expect(
      kimiCliCandidates({
        source: "local",
        agentId: "",
        commandPath: "uvx",
        commandArgs: ["kimi-cli==1.52.0", "acp"],
      }),
    ).toEqual(["kimi-legacy"]);
    expect(
      kimiCliCandidates({ source: "registry", agentId: "devin", commandPath: "", commandArgs: [] }),
    ).toBeUndefined();
    expect(
      kimiCliCandidates({
        source: "local",
        agentId: "",
        commandPath: "kimi-helper",
        commandArgs: [],
      }),
    ).toBeUndefined();
  });

  it.effect("maps the usages payload to windows and skips quotas it omits", () =>
    Effect.gen(function* () {
      expect(yield* kimiUsageWindows(USAGES)).toEqual([
        {
          id: "limit_5h",
          label: "5-hour",
          kind: "session",
          usedPercent: 7.48,
          resetsAt: "2026-11-15T22:52:15.000Z",
          windowDurationMins: 300,
        },
        {
          id: "limit_month_total",
          label: "Monthly",
          kind: "monthly",
          usedPercent: 32.52,
          resetsAt: "2026-12-07T00:00:00.000Z",
        },
      ]);
    }),
  );

  it.effect(
    "uses counted quotas as a fallback without inventing windows or accepting invalid ratios",
    () =>
      Effect.gen(function* () {
        const row = (duration: number, timeUnit: string, used: string, limit: string) => ({
          window: { duration, timeUnit },
          detail: { used, limit, resetTime: "2026-12-07T00:00:00Z" },
        });
        const windows = yield* kimiUsageWindows({
          limits: [
            row(5, "TIME_UNIT_HOUR", "25", "100"),
            row(1, "TIME_UNIT_WEEK", "40", "100"),
            row(1, "TIME_UNIT_DAY", "10", "100"),
            row(30, "TIME_UNIT_DAY", "75", "100"),
            row(2, "TIME_UNIT_HOUR", "-1", "100"),
            row(3, "TIME_UNIT_HOUR", "0", "0"),
            { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" } },
          ],
          usages: {
            limit_5h: { used_ratio: 0.5 },
            limit_7d: { used_ratio: "" },
            limit_month_code: { used_ratio: 0.99 },
          },
        });
        expect(windows.map(({ id, kind, usedPercent }) => ({ id, kind, usedPercent }))).toEqual([
          { id: "limit_5h", kind: "session", usedPercent: 50 },
          { id: "limit_7d", kind: "weekly", usedPercent: 40 },
          { id: "kimi-window-1440", kind: "other", usedPercent: 10 },
          { id: "limit_month_total", kind: "monthly", usedPercent: 75 },
        ]);
        expect(
          yield* kimiUsageWindows({
            usages: {
              limit_5h: { used_ratio: "  " },
              limit_7d: { used_ratio: -0.5 },
              limit_month_total: { used_ratio: "Infinity" },
            },
          }),
        ).toEqual([]);
      }),
  );

  it("reads TOML nested and inline tables and rejects malformed configuration", () => {
    expect(
      readKimiManagedProviderConfig(
        `providers = { "managed:kimi-code" = { base_url = "https://api.kimi.ai/coding/v1", oauth = { storage = "file", oauth_host = "https://auth.kimi.ai" } } }`,
      ),
    ).toMatchObject({
      hasOAuth: true,
      baseUrl: "https://api.kimi.ai/coding/v1",
      oauthHost: "https://auth.kimi.ai",
    });
    expect(() => readKimiManagedProviderConfig('[providers."managed:kimi-code"')).toThrow();
  });

  it.effect("derives the CLI's credential slot for each environment", () =>
    Effect.gen(function* () {
      const config = readKimiManagedProviderConfig(GLOBAL_CONFIG);
      expect(config).toEqual({
        hasOAuth: true,
        baseUrl: "https://api.kimi.ai/coding/v1",
        oauthHost: "https://auth.kimi.ai",
        oauthStorage: "file",
      });
      // Oracle: the slot Kimi Code 2.5.1 wrote for a kimi.ai login.
      expect((yield* resolveKimiCodeAuthTarget(config, {})).slot).toBe(
        "kimi-code-env-0e4f99c69cc27850",
      );
      expect(yield* resolveKimiCodeAuthTarget({ hasOAuth: false }, {})).toEqual({
        slot: "kimi-code",
        oauthHost: "https://auth.kimi.com",
        baseUrl: "https://api.kimi.com/coding/v1",
      });
      // An environment override replaces the configured host and base URL together.
      expect(
        yield* resolveKimiCodeAuthTarget(config, {
          KIMI_CODE_BASE_URL: "https://api.kimi.com/coding/v1/",
        }),
      ).toEqual({
        slot: "kimi-code",
        oauthHost: "https://auth.kimi.com",
        baseUrl: "https://api.kimi.com/coding/v1",
      });
      const inline = readKimiManagedProviderConfig(
        `[providers.'managed:kimi-code']\nbase_url = 'https://api.kimi.ai/coding/v1'\noauth = { storage = "file", oauth_host = "https://auth.kimi.ai" }\n`,
      );
      expect((yield* resolveKimiCodeAuthTarget(inline, {})).slot).toBe(
        "kimi-code-env-0e4f99c69cc27850",
      );
    }).pipe(Effect.provide(layer)),
  );

  it("accepts only HTTPS API endpoints, and loopback HTTP only when tests allow it", () => {
    expect(kimiApiBaseUrl(" https://api.kimi.com/coding/v1// ")).toBe(
      "https://api.kimi.com/coding/v1",
    );
    expect(kimiApiBaseUrl("http://api.kimi.com/coding/v1")).toBeUndefined();
    expect(kimiApiBaseUrl("http://127.0.0.1:9/v1")).toBeUndefined();
    expect(kimiApiBaseUrl("http://127.0.0.1:9/v1", { allowLoopbackHttp: true })).toBe(
      "http://127.0.0.1:9/v1",
    );
    expect(kimiApiBaseUrl("http://[::1]:9/v1", { allowLoopbackHttp: true })).toBe(
      "http://[::1]:9/v1",
    );
    expect(kimiApiBaseUrl("http://evil.example/v1", { allowLoopbackHttp: true })).toBeUndefined();
    expect(kimiApiBaseUrl("https://user:pass@api.kimi.com/coding/v1")).toBeUndefined();
    expect(kimiApiBaseUrl("https://api.kimi.com/coding/v1?next=x")).toBeUndefined();
    expect(kimiApiBaseUrl("https://api.kimi.com/coding/v1#x")).toBeUndefined();
    expect(kimiApiBaseUrl("file:///etc/passwd")).toBeUndefined();
    expect(kimiApiBaseUrl("api.kimi.com/coding/v1")).toBeUndefined();
  });

  it.effect("reads limits with a fresh token and leaves the CLI's files alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { probe, requests, tokenPath, listHome } = yield* fixture({ token: validToken });
      const before = yield* listHome;
      const limits = yield* probe;
      expect(limits.unavailable).toBeUndefined();
      expect(limits.windows.map((window) => window.id)).toEqual(["limit_5h", "limit_month_total"]);
      expect(limits.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(requests.map((request) => `${request.method} ${request.url}`).toSorted()).toEqual([
        "GET https://api.kimi.ai/coding/v1/me",
        "GET https://api.kimi.ai/coding/v1/usages",
      ]);
      for (const request of requests) {
        expect(request.authorization).toBe("Bearer access-current");
        // The bearer token must never follow a redirect.
        expect(request.redirect).toBe("manual");
      }
      expect(JSON.parse(yield* fs.readFileString(tokenPath))).toEqual(validToken);
      expect(yield* listHome).toEqual(before);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("reports an expired sign-in and never refreshes or rewrites it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { probe, requests, tokenPath, listHome } = yield* fixture({ token: expiredToken });
      const before = yield* listHome;
      const raw = yield* fs.readFileString(tokenPath);
      const limits = yield* probe;
      // "unsupported" so the previous reading is dropped rather than shown as current.
      expect(limits.unavailable).toEqual({ reason: "unsupported", message: EXPIRED_MESSAGE });
      expect(limits.windows).toEqual([]);
      expect(requests).toEqual([]);
      expect(yield* fs.readFileString(tokenPath)).toBe(raw);
      expect(yield* listHome).toEqual(before);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("treats a token about to lapse, or with no expiry, as unusable", () =>
    Effect.gen(function* () {
      const soon = yield* fixture({ token: { ...validToken, expires_at: NOW_SECONDS + 20 } });
      expect((yield* soon.probe).unavailable).toEqual({
        reason: "unsupported",
        message:
          "Kimi's sign-in is about to expire at 2027-01-15T08:00:20.000Z. Kimi renews it while you use it: use Kimi once, then refresh provider status.",
      });
      expect(soon.requests).toEqual([]);

      const { expires_at: _expiresAt, ...withoutExpiry } = validToken;
      const unknown = yield* fixture({ token: withoutExpiry });
      expect((yield* unknown.probe).unavailable?.message).toBe(
        "Kimi's stored sign-in has no expiry time. Use Kimi once, then refresh provider status.",
      );
      expect(unknown.requests).toEqual([]);

      const absurd = yield* fixture({ token: { ...validToken, expires_at: -1e300 } });
      expect((yield* absurd.probe).unavailable?.message).toBe(
        "Kimi's sign-in expired. Kimi renews it while you use it: use Kimi once, then refresh provider status.",
      );

      const tombstone = yield* fixture({ token: { ...validToken, access_token: "" } });
      expect((yield* tombstone.probe).unavailable).toEqual({
        reason: "unsupported",
        message: "Kimi's sign-in has ended. Sign in to Kimi again to see its limits.",
      });
      expect(tombstone.requests).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("shows limits again once Kimi has signed in or renewed its token", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { probe, tokenPath } = yield* fixture({ config: "" });
      expect((yield* probe).unavailable?.message).toBe("Sign in to Kimi Code to see its limits.");

      // Kimi Code signs in to the default slot; the same probe reads it on the next refresh.
      const defaultSlot = tokenPath.replace(/kimi-code-env-[0-9a-f]+\.json$/, "kimi-code.json");
      yield* fs.writeFileString(defaultSlot, JSON.stringify(expiredToken));
      expect((yield* probe).unavailable?.message).toBe(EXPIRED_MESSAGE);
      yield* fs.writeFileString(defaultSlot, JSON.stringify(validToken));
      const recovered = yield* probe;
      expect(recovered.unavailable).toBeUndefined();
      expect(recovered.windows).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("drops limits when Kimi rejects the token", () =>
    Effect.gen(function* () {
      for (const status of [401, 403]) {
        const { probe } = yield* fixture({
          token: validToken,
          respond: (url) => (url.endsWith("/usages") ? { status } : undefined),
        });
        expect((yield* probe).unavailable).toEqual({
          reason: "unsupported",
          message:
            "Kimi rejected its stored sign-in. Use Kimi once or sign in again, then refresh provider status.",
        });
      }
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("reports a transient failure without touching the token", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const offline = yield* fixture({ token: validToken, respond: () => "fail" });
      expect((yield* offline.probe).unavailable).toEqual({
        reason: "unsupported",
        message: "Could not read Kimi limits. Refresh provider status to retry.",
      });
      expect(JSON.parse(yield* fs.readFileString(offline.tokenPath))).toEqual(validToken);

      // A redirect is never followed with the token; the read just fails.
      const redirected = yield* fixture({
        token: validToken,
        respond: () => ({ status: 302 }),
      });
      expect((yield* redirected.probe).unavailable?.reason).toBe("unsupported");
      expect(redirected.requests.map((request) => request.url).toSorted()).toEqual([
        "https://api.kimi.ai/coding/v1/me",
        "https://api.kimi.ai/coding/v1/usages",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("never sends a token over plain HTTP or to a malformed endpoint", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Kimi Code keeps a separate credential slot for each overridden endpoint.
      const signIn = Effect.fn("KimiUsageTest.signIn")(function* (dir: string, baseUrl: string) {
        const { slot } = yield* resolveKimiCodeAuthTarget(
          { hasOAuth: false },
          { KIMI_CODE_BASE_URL: baseUrl },
        );
        yield* fs.writeFileString(path.join(dir, `${slot}.json`), JSON.stringify(validToken));
      });
      for (const baseUrl of [
        "http://api.kimi.ai/coding/v1",
        "http://127.0.0.1:8123/coding/v1",
        "https://user:secret@api.kimi.ai/coding/v1",
        "https://api.kimi.ai/coding/v1?redirect=https://evil.example",
      ]) {
        const { probe, requests, credentialsDir } = yield* fixture({
          config: "",
          environment: { KIMI_CODE_BASE_URL: baseUrl },
        });
        yield* signIn(credentialsDir, baseUrl);
        expect((yield* probe).unavailable).toEqual({
          reason: "unsupported",
          message: "Kimi limits are read only from an HTTPS Kimi endpoint.",
        });
        expect(requests).toEqual([]);
      }

      // Only a test that opts in may reach a loopback server over HTTP.
      const loopback = "http://127.0.0.1:8123/coding/v1";
      const local = yield* fixture({
        config: "",
        environment: { KIMI_CODE_BASE_URL: loopback },
        allowLoopbackHttp: true,
      });
      yield* signIn(local.credentialsDir, loopback);
      expect((yield* local.probe).windows).toHaveLength(2);
      expect(local.requests.map((request) => request.url)).toContain(`${loopback}/usages`);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("does not follow redirects with a real fetch client", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const received: string[] = [];
      const server = NodeHttp.createServer((request, response) => {
        received.push(request.url ?? "");
        if (request.url === "/coding/v1/usages") {
          response.writeHead(302, { Location: "/capture" });
          response.end();
        } else {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ user_id: "fixture-user" }));
        }
      });
      yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              server.once("error", reject);
              server.listen(0, "127.0.0.1", resolve);
            }),
        ),
        () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No fixture port");
      const baseUrl = `http://127.0.0.1:${address.port}/coding/v1`;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "kimi-fetch-" });
      const { slot } = yield* resolveKimiCodeAuthTarget(
        { hasOAuth: false },
        { KIMI_CODE_BASE_URL: baseUrl },
      );
      yield* fs.makeDirectory(path.join(root, "credentials"));
      const tokenPath = path.join(root, "credentials", `${slot}.json`);
      const original = JSON.stringify({ access_token: "fixture-only", expires_at: 4102444800 });
      yield* fs.writeFileString(tokenPath, original);
      const probe = yield* makeKimiUsageProbe({
        candidates: ["kimi-code"],
        environment: { KIMI_CODE_HOME: root, KIMI_CODE_BASE_URL: baseUrl },
        allowLoopbackHttp: true,
      });
      expect((yield* probe).unavailable).toBeDefined();
      expect(received.toSorted()).toEqual(["/coding/v1/me", "/coding/v1/usages"]);
      expect(yield* fs.readFileString(tokenPath)).toBe(original);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layer, FetchHttpClient.layer))),
  );

  it.effect("sends the legacy CLI's token only to Kimi's default endpoint", () =>
    Effect.gen(function* () {
      const custom = yield* fixture({
        config: "",
        legacyToken: validToken,
        candidates: ["kimi-legacy"],
        environment: { KIMI_CODE_BASE_URL: "https://proxy.example/v1" },
      });
      expect((yield* custom.probe).unavailable).toEqual({
        reason: "unsupported",
        message: "Limits for the legacy Kimi CLI are read only from Kimi's default endpoint.",
      });
      expect(custom.requests).toEqual([]);

      const explicitDefault = yield* fixture({
        config: "",
        legacyToken: validToken,
        candidates: ["kimi-legacy"],
        environment: { KIMI_CODE_BASE_URL: "https://api.kimi.com/coding/v1/" },
      });
      expect((yield* explicitDefault.probe).windows).toHaveLength(2);
      expect(explicitDefault.requests.map((request) => request.url)).toContain(
        "https://api.kimi.com/coding/v1/usages",
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "does not substitute legacy credentials for a configured modern account or API key",
    () =>
      Effect.gen(function* () {
        for (const config of [
          GLOBAL_CONFIG,
          GLOBAL_CONFIG.replace('api_key = ""', 'api_key = "explicit-api-key"'),
          GLOBAL_CONFIG.replace('api_key = ""', 'api_key_env = "MY_KIMI_KEY"'),
          '[providers."managed:kimi-code"',
        ]) {
          const current = yield* fixture({
            config,
            legacyToken: validToken,
            candidates: ["kimi-code", "kimi-legacy"],
          });
          expect((yield* current.probe).windows).toEqual([]);
          expect(current.requests).toEqual([]);
        }
        const expired = yield* fixture({
          token: expiredToken,
          legacyToken: validToken,
          candidates: ["kimi-code", "kimi-legacy"],
        });
        expect((yield* expired.probe).unavailable?.message).toBe(EXPIRED_MESSAGE);
        expect(expired.requests).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("asks for a sign-in when no Kimi generation has credentials", () =>
    Effect.gen(function* () {
      const { probe, requests } = yield* fixture({
        config: "",
        candidates: ["kimi-code", "kimi-legacy"],
      });
      const limits = yield* probe;
      expect(limits.unavailable).toEqual({
        reason: "unsupported",
        message: "Sign in to Kimi Code to see its limits.",
      });
      expect(requests).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("reads the legacy CLI's fresh token and reports its expiry", () =>
    Effect.gen(function* () {
      const fresh = yield* fixture({
        config: "",
        legacyToken: validToken,
        candidates: ["kimi-code", "kimi-legacy"],
      });
      const limits = yield* fresh.probe;
      expect(limits.windows).toHaveLength(2);
      expect(fresh.requests.map((request) => request.url)).toContain(
        "https://api.kimi.com/coding/v1/usages",
      );

      // Kimi Code was never signed in, so the legacy CLI's expiry is the useful report.
      const expired = yield* fixture({
        config: "",
        legacyToken: expiredToken,
        candidates: ["kimi-code", "kimi-legacy"],
      });
      expect((yield* expired.probe).unavailable?.message).toBe(EXPIRED_MESSAGE);
      expect(expired.requests).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
