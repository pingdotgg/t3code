import { describe, expect, it } from "@effect/vitest";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { kimiOAuthKey, kimiUsageResponseToLimits, readKimiUsageLimits } from "./kimiUsageLimits.ts";

/**
 * The shape Kimi's `/usages` endpoint answers with on both managed hosts;
 * `remaining` arrives too but is informational.
 */
const liveResponse = {
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: {
        limit: "100",
        used: "19",
        remaining: "81",
        resetTime: "2026-11-13T16:16:25.411087Z",
      },
    },
  ],
  usages: {
    limit_5h: { used_ratio: 0.1857, reset_time: "2026-11-13T16:16:24Z" },
    limit_month_total: { used_ratio: 0.3616, reset_time: "2026-12-12T00:00:00Z" },
    limit_month_code: { used_ratio: 0.3616, reset_time: "2026-12-12T00:00:00Z" },
  },
} as const;

describe("kimiOAuthKey", () => {
  it("maps the managed deployments to the CLI's shared slot", () => {
    for (const baseUrl of ["https://api.kimi.com/coding/v1", "https://api.kimi.ai/coding/v1"]) {
      expect(
        kimiOAuthKey({ oauthHost: "https://auth.kimi.com", baseUrl, sha256Hex: "0".repeat(64) }),
      ).toBe("kimi-code");
    }
  });

  it("scopes any other environment to a hash of its endpoints", () => {
    expect(
      kimiOAuthKey({
        oauthHost: "https://auth.kimi.ai",
        baseUrl: "https://api.kimi.ai/coding/v1",
        sha256Hex: "0e4f99c69cc27850594b4d64b6b7126c4e69f04c9deb2f6dd17d2946d0541a2b",
      }),
    ).toBe("kimi-code-env-0e4f99c69cc27850");
  });
});

describe("kimiUsageResponseToLimits", () => {
  it("derives session and monthly windows from Kimi's live shape", () => {
    const limits = kimiUsageResponseToLimits(liveResponse, "2026-11-13T12:00:00.000Z");
    expect(limits).toEqual({
      checkedAt: "2026-11-13T12:00:00.000Z",
      windows: [
        {
          id: "session",
          kind: "session",
          label: "Session",
          usedPercent: 19,
          resetsAt: "2026-11-13T16:16:25.411Z",
          windowDurationMins: 300,
        },
        {
          id: "monthly",
          kind: "monthly",
          label: "Monthly",
          usedPercent: 36.16,
          resetsAt: "2026-12-12T00:00:00.000Z",
          windowDurationMins: 30 * 24 * 60,
        },
      ],
    });
  });

  it("falls back to ratios when a deployment drops the counted rows", () => {
    const limits = kimiUsageResponseToLimits(
      { usages: liveResponse.usages },
      "2026-11-13T12:00:00.000Z",
    );
    expect(limits.windows).toHaveLength(2);
    expect(limits.windows.find((window) => window.id === "session")).toMatchObject({
      usedPercent: 18.57,
      windowDurationMins: 300,
    });
    expect(limits.windows.find((window) => window.id === "monthly")).toMatchObject({
      usedPercent: 36.16,
    });
  });

  it("produces no windows for a signed-out or non-managed account", () => {
    expect(kimiUsageResponseToLimits({}, "2026-11-13T12:00:00.000Z").windows).toHaveLength(0);
    expect(
      kimiUsageResponseToLimits(
        {
          limits: [
            {
              window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
              // A zero limit cannot produce a percentage.
              detail: { limit: "0", used: "0", resetTime: "2026-11-13T16:16:25.411087Z" },
            },
          ],
        },
        "2026-11-13T12:00:00.000Z",
      ).windows,
    ).toHaveLength(0);
  });

  it("publishes a weekly-kind window when Kimi reports one", () => {
    const limits = kimiUsageResponseToLimits(
      {
        limits: [
          {
            window: { duration: 1, timeUnit: "TIME_UNIT_WEEK" },
            detail: { limit: "10", used: "1" },
          },
        ],
      },
      "2026-11-13T12:00:00.000Z",
    );
    expect(limits.windows).toEqual([
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 10,
        windowDurationMins: 7 * 24 * 60,
      },
    ]);
  });

  it("keeps the code breakdown from shadowing the total monthly quota", () => {
    const limits = kimiUsageResponseToLimits(
      {
        usages: {
          limit_month_code: { used_ratio: 0.1 },
          limit_month_total: { used_ratio: 0.8 },
        },
      },
      "2026-11-13T12:00:00.000Z",
    );
    expect(limits.windows).toEqual([
      {
        id: "monthly",
        kind: "monthly",
        label: "Monthly",
        usedPercent: 80,
        windowDurationMins: 30 * 24 * 60,
      },
    ]);
  });

  it("maps `limit_7d` ratios to the weekly window", () => {
    const limits = kimiUsageResponseToLimits(
      { usages: { limit_7d: { used_ratio: 0.5, reset_time: "2026-11-17T00:00:00Z" } } },
      "2026-11-13T12:00:00.000Z",
    );
    expect(limits.windows).toEqual([
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 50,
        resetsAt: "2026-11-17T00:00:00.000Z",
        windowDurationMins: 10080,
      },
    ]);
  });
});

/**
 * Answers `${oauthHost}/api/oauth/token` and `${baseUrl}/usages` like Kimi's
 * servers. The stored credential is always fresh unless a test overrides it.
 */
function kimiHomeWithHttpClient(options: {
  readonly respond: (request: { readonly method: string; readonly url: string }) => {
    readonly status: number;
    readonly body: string;
  };
}) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-kimi-usage-",
    });
    const respond = (request: { readonly method: string; readonly url: string }) =>
      options.respond({ method: request.method, url: request.url });
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(respond(request).body, { status: respond(request).status }),
        ),
      ),
    );
    const writeCredential = (contents: string) =>
      fileSystem.writeFileString(
        path.join(homeDirectory, "credentials", "kimi-code.json"),
        contents,
      );
    return { homeDirectory, client, writeCredential, path, fileSystem };
  });
}

// The test clock sits at 2026-11-13T12:00:00.000Z; refresh runs inside a
// 60-second window before this expiry.
const FRESH_CREDENTIAL = {
  access_token: "fresh-access",
  refresh_token: "stored-refresh",
  expires_at: Math.floor(Date.parse("2026-11-13T13:00:00.000Z") / 1000),
  scope: "kimi-code",
  token_type: "Bearer",
  expires_in: 900,
};
const STALE_CREDENTIAL = {
  ...FRESH_CREDENTIAL,
  access_token: "stale-access",
  expires_at: Math.floor(Date.parse("2026-11-13T12:00:30.000Z") / 1000),
};

describe("readKimiUsageLimits", () => {
  it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer), { excludeTestServices: true })(
    "readKimiUsageLimits",
    (it) => {
      const usagesBody = JSON.stringify({
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "100", used: "19" },
          },
        ],
      });

      it.effect("reports windows by reading Kimi's own credential store", () =>
        Effect.gen(function* () {
          const kimi = yield* kimiHomeWithHttpClient({
            respond: ({ url }) =>
              url.endsWith("/usages")
                ? { status: 200, body: usagesBody }
                : { status: 500, body: "{}" },
          });
          yield* kimi.fileSystem.makeDirectory(kimi.path.join(kimi.homeDirectory, "credentials"), {
            recursive: true,
          });
          yield* kimi.writeCredential(JSON.stringify(FRESH_CREDENTIAL));
          const limits = yield* readKimiUsageLimits({
            environment: { KIMI_CODE_HOME: kimi.homeDirectory },
            nowMs: Date.parse("2026-11-13T12:00:00.000Z"),
          }).pipe(Effect.provideService(HttpClient.HttpClient, kimi.client));
          expect(limits).toMatchObject({
            checkedAt: "2026-11-13T12:00:00.000Z",
            windows: [{ id: "session", usedPercent: 19 }],
          });
        }),
      );

      it.effect("keeps an absent managed credential out of scope instead of failing", () =>
        Effect.gen(function* () {
          const kimi = yield* kimiHomeWithHttpClient({
            respond: () => ({ status: 500, body: "{}" }),
          });
          const limits = yield* readKimiUsageLimits({
            environment: { KIMI_CODE_HOME: kimi.homeDirectory },
            nowMs: Date.parse("2026-11-13T12:00:00.000Z"),
          }).pipe(Effect.provideService(HttpClient.HttpClient, kimi.client));
          expect(limits).toBeUndefined();
        }),
      );

      it.effect("reports probeFailed when the account cannot use the usage endpoint", () =>
        Effect.gen(function* () {
          const kimi = yield* kimiHomeWithHttpClient({
            respond: ({ url }) =>
              url.endsWith("/usages") ? { status: 401, body: "{}" } : { status: 500, body: "{}" },
          });
          yield* kimi.fileSystem.makeDirectory(kimi.path.join(kimi.homeDirectory, "credentials"), {
            recursive: true,
          });
          yield* kimi.writeCredential(JSON.stringify(FRESH_CREDENTIAL));
          const limits = yield* readKimiUsageLimits({
            environment: { KIMI_CODE_HOME: kimi.homeDirectory },
            nowMs: Date.parse("2026-11-13T12:00:00.000Z"),
          }).pipe(Effect.provideService(HttpClient.HttpClient, kimi.client));
          expect(limits).toMatchObject({
            unavailable: expect.objectContaining({ reason: "probeFailed" }),
            windows: [],
          });
        }),
      );

      it.effect("reports probeFailed when another error status answers the usages request", () =>
        Effect.gen(function* () {
          const kimi = yield* kimiHomeWithHttpClient({
            respond: ({ url }) =>
              url.endsWith("/usages") ? { status: 500, body: "{}" } : { status: 500, body: "{}" },
          });
          yield* kimi.fileSystem.makeDirectory(kimi.path.join(kimi.homeDirectory, "credentials"), {
            recursive: true,
          });
          yield* kimi.writeCredential(JSON.stringify(FRESH_CREDENTIAL));
          const limits = yield* readKimiUsageLimits({
            environment: { KIMI_CODE_HOME: kimi.homeDirectory },
            nowMs: Date.parse("2026-11-13T12:00:00.000Z"),
          }).pipe(Effect.provideService(HttpClient.HttpClient, kimi.client));
          expect(limits).toMatchObject({
            unavailable: expect.objectContaining({ reason: "probeFailed" }),
            windows: [],
          });
        }),
      );

      it.effect("reports probeFailed when a stale token cannot be refreshed", () =>
        Effect.gen(function* () {
          const kimi = yield* kimiHomeWithHttpClient({
            respond: ({ url }) =>
              url.endsWith("/api/oauth/token")
                ? { status: 400, body: "{}" }
                : { status: 200, body: usagesBody },
          });
          yield* kimi.fileSystem.makeDirectory(kimi.path.join(kimi.homeDirectory, "credentials"), {
            recursive: true,
          });
          yield* kimi.writeCredential(JSON.stringify(STALE_CREDENTIAL));
          const limits = yield* readKimiUsageLimits({
            environment: { KIMI_CODE_HOME: kimi.homeDirectory },
            nowMs: Date.parse("2026-11-13T12:00:00.000Z"),
          }).pipe(Effect.provideService(HttpClient.HttpClient, kimi.client));
          expect(limits).toMatchObject({
            unavailable: expect.objectContaining({ reason: "probeFailed" }),
            windows: [],
          });
        }),
      );

      it.effect("refreshes a stale token and persists the rotated credential atomically", () =>
        Effect.gen(function* () {
          const kimi = yield* kimiHomeWithHttpClient({
            respond: ({ url }) =>
              url.endsWith("/api/oauth/token")
                ? {
                    status: 200,
                    body: JSON.stringify({
                      access_token: "rotated-access",
                      refresh_token: "rotated-refresh",
                      expires_at: Math.floor(Date.parse("2026-11-13T12:10:00.000Z") / 1000),
                    }),
                  }
                : { status: 200, body: usagesBody },
          });
          yield* kimi.fileSystem.makeDirectory(kimi.path.join(kimi.homeDirectory, "credentials"), {
            recursive: true,
          });
          yield* kimi.writeCredential(JSON.stringify(STALE_CREDENTIAL));
          const limits = yield* readKimiUsageLimits({
            environment: { KIMI_CODE_HOME: kimi.homeDirectory },
            nowMs: Date.parse("2026-11-13T12:00:00.000Z"),
          }).pipe(Effect.provideService(HttpClient.HttpClient, kimi.client));
          expect(limits).toMatchObject({
            windows: [{ id: "session", usedPercent: 19 }],
          });
          const persisted = yield* kimi.fileSystem.readFileString(
            kimi.path.join(kimi.homeDirectory, "credentials", "kimi-code.json"),
          );
          expect(JSON.parse(persisted)).toMatchObject({
            access_token: "rotated-access",
            refresh_token: "rotated-refresh",
          });
          // Refreshed tokens must not leak through a wider file mode; Windows
          // does not implement the POSIX bits the check reads.
          if (HostProcess.Platform.defaultValue() === "win32") return;
          const credentialPath = kimi.path.join(
            kimi.homeDirectory,
            "credentials",
            "kimi-code.json",
          );
          const mode = (yield* kimi.fileSystem.stat(credentialPath)).mode & 0o777;
          expect(mode).toBe(0o600);
        }),
      );

      it.effect("keeps a CLI rotation that lands mid-refresh, instead of reverting it", () =>
        Effect.gen(function* () {
          const kimi = yield* kimiHomeWithHttpClient({
            respond: ({ url }) => {
              if (url.endsWith("/api/oauth/token")) {
                // The CLI rotates the same credential file while the reader's
                // refresh call is in flight.
                return {
                  status: 200,
                  body: JSON.stringify({
                    access_token: "reader-access",
                    refresh_token: "reader-refresh",
                    expires_at: Math.floor(Date.parse("2026-11-13T12:10:00.000Z") / 1000),
                  }),
                };
              }
              return { status: 200, body: usagesBody };
            },
          });
          const credentialPath = kimi.path.join(
            kimi.homeDirectory,
            "credentials",
            "kimi-code.json",
          );
          yield* kimi.fileSystem.makeDirectory(kimi.path.join(kimi.homeDirectory, "credentials"), {
            recursive: true,
          });
          yield* kimi.writeCredential(JSON.stringify(STALE_CREDENTIAL));
          // The refresh handler answers before the writeback, and the CLI's
          // rotation lands between the reader's initial read and that writeback.
          const originalClient = kimi.client;
          const rotatingClient = HttpClient.make((request) =>
            Effect.gen(function* () {
              const response = yield* originalClient.execute(request);
              if (request.url.endsWith("/api/oauth/token")) {
                // The CLI's rotation is best-effort inside the stub: this test
                // only cares that it lands before the reader's writeback.
                yield* kimi.fileSystem
                  .writeFileString(
                    credentialPath,
                    JSON.stringify({
                      ...STALE_CREDENTIAL,
                      access_token: "cli-access",
                      refresh_token: "cli-rotated-refresh",
                      expires_at: Math.floor(Date.parse("2026-11-13T12:20:00.000Z") / 1000),
                    }),
                  )
                  .pipe(Effect.orElseSucceed(() => undefined));
              }
              return response;
            }),
          );
          const limits = yield* readKimiUsageLimits({
            environment: { KIMI_CODE_HOME: kimi.homeDirectory },
            nowMs: Date.parse("2026-11-13T12:00:00.000Z"),
          }).pipe(Effect.provideService(HttpClient.HttpClient, rotatingClient));
          // The lookup proceeds with the reader's fresh access token.
          expect(limits).toMatchObject({
            windows: [{ id: "session", usedPercent: 19 }],
          });
          // The CLI's rotated refresh token must survive the reader's writeback.
          const persisted = JSON.parse(yield* kimi.fileSystem.readFileString(credentialPath));
          expect(persisted).toMatchObject({
            access_token: "reader-access",
            refresh_token: "cli-rotated-refresh",
          });
          expect(persisted.refresh_token).not.toBe("reader-refresh");
        }),
      );

      it.effect("keeps a config-level api_key override out of the OAuth scope", () =>
        Effect.gen(function* () {
          const kimi = yield* kimiHomeWithHttpClient({
            respond: () => ({ status: 500, body: "{}" }),
          });
          yield* kimi.fileSystem.makeDirectory(kimi.path.join(kimi.homeDirectory, "credentials"), {
            recursive: true,
          });
          yield* kimi.writeCredential(JSON.stringify(FRESH_CREDENTIAL));
          yield* kimi.fileSystem.writeFileString(
            kimi.path.join(kimi.homeDirectory, "config.toml"),
            ['[providers."managed:kimi-code"]', 'api_key = "sk-custom-key"', ""].join("\n"),
          );
          const limits = yield* readKimiUsageLimits({
            environment: { KIMI_CODE_HOME: kimi.homeDirectory } as NodeJS.ProcessEnv,
            nowMs: Date.parse("2026-11-13T12:00:00.000Z"),
          }).pipe(Effect.provideService(HttpClient.HttpClient, kimi.client));
          expect(limits).toBeUndefined();
        }),
      );

      it.effect("keeps a config-level api_key_env override out of the OAuth scope", () =>
        Effect.gen(function* () {
          const kimi = yield* kimiHomeWithHttpClient({
            respond: () => ({ status: 500, body: "{}" }),
          });
          yield* kimi.fileSystem.makeDirectory(kimi.path.join(kimi.homeDirectory, "credentials"), {
            recursive: true,
          });
          yield* kimi.writeCredential(JSON.stringify(FRESH_CREDENTIAL));
          yield* kimi.fileSystem.writeFileString(
            kimi.path.join(kimi.homeDirectory, "config.toml"),
            ['[providers."managed:kimi-code"]', 'api_key_env = "MY_KEY"', ""].join("\n"),
          );
          const limits = yield* readKimiUsageLimits({
            environment: {
              KIMI_CODE_HOME: kimi.homeDirectory,
              MY_KEY: "sk-custom-key",
            } as NodeJS.ProcessEnv,
            nowMs: Date.parse("2026-11-13T12:00:00.000Z"),
          }).pipe(Effect.provideService(HttpClient.HttpClient, kimi.client));
          expect(limits).toBeUndefined();
        }),
      );

      it.effect("honors KIMI_CODE_BASE_URL and KIMI_CODE_OAUTH_HOST over the config file", () =>
        Effect.gen(function* () {
          const kimi = yield* kimiHomeWithHttpClient({
            respond: ({ url }) =>
              url.startsWith("https://override.test")
                ? { status: 200, body: usagesBody }
                : { status: 500, body: "{}" },
          });
          yield* kimi.fileSystem.makeDirectory(kimi.path.join(kimi.homeDirectory, "credentials"), {
            recursive: true,
          });
          // Without an env override the config pins a different credential slot.
          yield* kimi.fileSystem.writeFileString(
            kimi.path.join(kimi.homeDirectory, "config.toml"),
            [
              '[providers."managed:kimi-code"]',
              'base_url = "https://config.test/coding/v1"',
              "",
              '[providers."managed:kimi-code".oauth]',
              'oauth_host = "https://config-oauth.test"',
              'key = "oauth/config-slot"',
              "",
            ].join("\n"),
          );
          yield* kimi.fileSystem.writeFileString(
            kimi.path.join(kimi.homeDirectory, "credentials", "config-slot.json"),
            JSON.stringify(FRESH_CREDENTIAL),
          );
          const limits = yield* readKimiUsageLimits({
            environment: {
              KIMI_CODE_HOME: kimi.homeDirectory,
              KIMI_CODE_BASE_URL: "https://override.test/coding/v1",
              KIMI_CODE_OAUTH_HOST: "https://override.test",
            } as NodeJS.ProcessEnv,
            nowMs: Date.parse("2026-11-13T12:00:00.000Z"),
          }).pipe(Effect.provideService(HttpClient.HttpClient, kimi.client));
          // The env override re-derives the scoped credential slot from the
          // override endpoints, so the config-pinned slot is not read.
          expect(limits).toBeUndefined();
        }),
      );

      it.effect("reads the config-pinned credential slot without an env override", () =>
        Effect.gen(function* () {
          const kimi = yield* kimiHomeWithHttpClient({
            respond: ({ url }) =>
              url.startsWith("https://config.test")
                ? { status: 200, body: usagesBody }
                : { status: 500, body: "{}" },
          });
          yield* kimi.fileSystem.makeDirectory(kimi.path.join(kimi.homeDirectory, "credentials"), {
            recursive: true,
          });
          yield* kimi.fileSystem.writeFileString(
            kimi.path.join(kimi.homeDirectory, "config.toml"),
            [
              '[providers."managed:kimi-code"]',
              'base_url = "https://config.test/coding/v1"',
              "",
              '[providers."managed:kimi-code".oauth]',
              'oauth_host = "https://auth.kimi.com"',
              'key = "oauth/config-slot"',
              "",
            ].join("\n"),
          );
          yield* kimi.fileSystem.writeFileString(
            kimi.path.join(kimi.homeDirectory, "credentials", "config-slot.json"),
            JSON.stringify(FRESH_CREDENTIAL),
          );
          const limits = yield* readKimiUsageLimits({
            environment: { KIMI_CODE_HOME: kimi.homeDirectory } as NodeJS.ProcessEnv,
            nowMs: Date.parse("2026-11-13T12:00:00.000Z"),
          }).pipe(Effect.provideService(HttpClient.HttpClient, kimi.client));
          expect(limits).toMatchObject({
            windows: [{ id: "session", usedPercent: 19 }],
          });
        }),
      );

      it.effect("reads single-quoted TOML spellings of the managed config", () =>
        Effect.gen(function* () {
          const kimi = yield* kimiHomeWithHttpClient({
            respond: ({ url }) =>
              url.startsWith("https://config.test")
                ? { status: 200, body: usagesBody }
                : { status: 500, body: "{}" },
          });
          yield* kimi.fileSystem.makeDirectory(kimi.path.join(kimi.homeDirectory, "credentials"), {
            recursive: true,
          });
          // TOML permits literal (single-quoted) keys and values; the same
          // sections resolve identically to the double-quoted spelling.
          yield* kimi.fileSystem.writeFileString(
            kimi.path.join(kimi.homeDirectory, "config.toml"),
            [
              "[providers.'managed:kimi-code']",
              "base_url = 'https://config.test/coding/v1'",
              "",
              "[providers.'managed:kimi-code'.oauth]",
              "oauth_host = 'https://auth.kimi.com'",
              "key = 'oauth/config-slot'",
              "",
            ].join("\n"),
          );
          yield* kimi.fileSystem.writeFileString(
            kimi.path.join(kimi.homeDirectory, "credentials", "config-slot.json"),
            JSON.stringify(FRESH_CREDENTIAL),
          );
          const limits = yield* readKimiUsageLimits({
            environment: { KIMI_CODE_HOME: kimi.homeDirectory } as NodeJS.ProcessEnv,
            nowMs: Date.parse("2026-11-13T12:00:00.000Z"),
          }).pipe(Effect.provideService(HttpClient.HttpClient, kimi.client));
          expect(limits).toMatchObject({
            windows: [{ id: "session", usedPercent: 19 }],
          });
        }),
      );
    },
  );

  // TestClock would freeze the lock's bounded retry sleeps forever, so the
  // held-lock case runs against the real clock outside the shared layer block.
  it.live("completes the lookup when the credential lock is already held", () =>
    Effect.gen(function* () {
      const usagesBody = JSON.stringify({
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "100", used: "19" },
          },
        ],
      });
      const kimi = yield* kimiHomeWithHttpClient({
        respond: ({ url }) =>
          url.endsWith("/api/oauth/token")
            ? {
                status: 200,
                body: JSON.stringify({
                  access_token: "rotated-access",
                  refresh_token: "rotated-refresh",
                  expires_at: Math.floor(Date.parse("2026-11-13T12:10:00.000Z") / 1000),
                }),
              }
            : { status: 200, body: usagesBody },
      });
      yield* kimi.fileSystem.makeDirectory(kimi.path.join(kimi.homeDirectory, "credentials"), {
        recursive: true,
      });
      yield* kimi.writeCredential(JSON.stringify(STALE_CREDENTIAL));
      // Another process (the CLI) holds the lock and never releases it.
      yield* kimi.fileSystem.writeFileString(
        kimi.path.join(kimi.homeDirectory, "credentials", "kimi-code.lock"),
        "held-by-cli",
      );
      const limits = yield* readKimiUsageLimits({
        environment: { KIMI_CODE_HOME: kimi.homeDirectory } as NodeJS.ProcessEnv,
        nowMs: Date.parse("2026-11-13T12:00:00.000Z"),
      }).pipe(Effect.provideService(HttpClient.HttpClient, kimi.client));
      // The bounded wait expires and the lookup proceeds without the lock.
      expect(limits).toMatchObject({
        windows: [{ id: "session", usedPercent: 19 }],
      });
      // Proceeding without the lock still wrote back a consistent credential.
      const persisted = JSON.parse(
        yield* kimi.fileSystem.readFileString(
          kimi.path.join(kimi.homeDirectory, "credentials", "kimi-code.json"),
        ),
      );
      expect(persisted).toMatchObject({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
      });
      // The holder's lock file is left in place: this reader released nothing.
      const lockHeld = yield* kimi.fileSystem.exists(
        kimi.path.join(kimi.homeDirectory, "credentials", "kimi-code.lock"),
      );
      expect(lockHeld).toBe(true);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
