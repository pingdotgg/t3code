import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  KimiAuthDeniedError,
  KimiAuthExpiredError,
  KimiAuthInstanceInvalidError,
  KimiAuthRequestError,
  ProviderInstanceId,
  ServerSettings,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  buildKimiCredentialsJson,
  removeKimiCredentials,
  resolveKimiAuthTarget,
  resolveKimiCodeHome,
  resolveKimiSignInHomePath,
  signInWithKimi,
  writeKimiCredentials,
} from "./KimiOAuth.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

describe("buildKimiCredentialsJson", () => {
  it("matches kimi-cli's credential file shape", () => {
    const json = buildKimiCredentialsJson(
      {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 900,
        scope: "kimi-code",
        token_type: "Bearer",
      },
      1_000_000,
    );
    expect(JSON.parse(json)).toEqual({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_at: 1_900,
      scope: "kimi-code",
      token_type: "Bearer",
      expires_in: 900,
    });
    expect(json.endsWith("\n")).toBe(true);
  });

  it("fills kimi-cli defaults for optional token fields", () => {
    const parsed = JSON.parse(
      buildKimiCredentialsJson({ access_token: "access-1", refresh_token: "refresh-1" }, 0),
    );
    expect(parsed.expires_in).toBe(900);
    expect(parsed.scope).toBe("kimi-code");
    expect(parsed.token_type).toBe("Bearer");
  });
});

describe("resolveKimiCodeHome", () => {
  it("prefers a configured home path over the CLI default", () => {
    expect(resolveKimiCodeHome("/data/kimi-work")).toBe("/data/kimi-work");
    expect(resolveKimiCodeHome("  ")).toContain(".kimi-code");
    expect(resolveKimiCodeHome(undefined)).toContain(".kimi-code");
  });
});

describe("resolveKimiSignInHomePath", () => {
  it.effect("prefers the targeted instance's homePath", () =>
    Effect.gen(function* () {
      const settings = decodeServerSettings({
        providers: { kimi: { homePath: "/legacy/home" } },
        providerInstances: {
          kimi_work: { driver: "kimi", config: { homePath: "/work/home" } },
        },
      });
      expect(yield* resolveKimiSignInHomePath(settings, ProviderInstanceId.make("kimi_work"))).toBe(
        "/work/home",
      );
    }),
  );

  it.effect("uses the legacy home only for the synthesized default Kimi instance", () =>
    Effect.gen(function* () {
      const settings = decodeServerSettings({
        providers: { kimi: { homePath: "/legacy/home" } },
      });
      expect(yield* resolveKimiSignInHomePath(settings, undefined)).toBe("/legacy/home");
      expect(yield* resolveKimiSignInHomePath(settings, ProviderInstanceId.make("kimi"))).toBe(
        "/legacy/home",
      );
    }),
  );

  it.effect("rejects missing and non-Kimi explicit instances", () =>
    Effect.gen(function* () {
      const settings = decodeServerSettings({
        providerInstances: {
          codex_work: { driver: "codex", config: {} },
        },
      });
      const missing = yield* resolveKimiAuthTarget(
        settings,
        ProviderInstanceId.make("kimi_missing"),
      ).pipe(Effect.flip);
      const wrongDriver = yield* resolveKimiAuthTarget(
        settings,
        ProviderInstanceId.make("codex_work"),
      ).pipe(Effect.flip);

      expect(missing).toBeInstanceOf(KimiAuthInstanceInvalidError);
      expect(missing.issue).toBe("not-found");
      expect(wrongDriver).toBeInstanceOf(KimiAuthInstanceInvalidError);
      expect(wrongDriver.issue).toBe("wrong-driver");
    }),
  );

  it.effect("returns undefined when no home path is configured anywhere", () =>
    Effect.gen(function* () {
      expect(yield* resolveKimiSignInHomePath(decodeServerSettings({}), undefined)).toBe(undefined);
    }),
  );
});

interface RecordedRequest {
  readonly url: string;
  readonly params: URLSearchParams;
}

type MockResponse = { readonly status: number; readonly body: unknown };

const makeKimiOAuthHttpLayer = (
  requests: Array<RecordedRequest>,
  respond: (url: string, callIndex: number) => MockResponse,
) => {
  let calls = 0;
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        requests.push({ url: request.url, params: new URLSearchParams(body) });
        const response = respond(request.url, calls);
        calls += 1;
        return HttpClientResponse.fromWeb(
          request,
          // @effect-diagnostics-next-line preferSchemaOverJson:off - mock wire payloads are free-form test fixtures.
          new Response(JSON.stringify(response.body), {
            status: response.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );
};

const DEVICE_AUTHORIZATION_BODY = {
  device_code: "device-code-1",
  user_code: "ABCD-1234",
  verification_uri: "https://auth.kimi.com/device",
  verification_uri_complete: "https://auth.kimi.com/device?code=ABCD-1234",
  expires_in: 600,
  interval: 5,
};

it.layer(NodeServices.layer)("signInWithKimi", (it) => {
  it.effect("emits verification, then writes the credential and completes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimi-oauth-" });

      const requests: Array<RecordedRequest> = [];
      const httpLayer = makeKimiOAuthHttpLayer(requests, (url, callIndex) => {
        if (url.includes("device_authorization")) {
          return { status: 200, body: DEVICE_AUTHORIZATION_BODY };
        }
        return callIndex < 2
          ? { status: 400, body: { error: "authorization_pending" } }
          : {
              status: 200,
              body: {
                access_token: "access-1",
                refresh_token: "refresh-1",
                expires_in: 900,
                scope: "kimi-code",
                token_type: "Bearer",
              },
            };
      });

      const collected = yield* signInWithKimi({ homePath: home }).pipe(
        Stream.runCollect,
        Effect.provide(httpLayer),
        Effect.forkChild,
      );
      // First poll waits the advertised interval; the second follows a
      // pending answer. Two adjustments release both sleeps.
      yield* TestClock.adjust("5 seconds");
      yield* TestClock.adjust("5 seconds");
      const events = yield* Fiber.join(collected);

      expect(events).toEqual([
        {
          type: "verification",
          verificationUri: "https://auth.kimi.com/device?code=ABCD-1234",
          userCode: "ABCD-1234",
          expiresInSeconds: 600,
        },
        { type: "completed" },
      ]);

      const grants = requests.filter((request) => request.url.includes("/api/oauth/token"));
      expect(grants).toHaveLength(2);
      expect(grants[0]?.params.get("grant_type")).toBe(
        "urn:ietf:params:oauth:grant-type:device_code",
      );
      expect(grants[0]?.params.get("device_code")).toBe("device-code-1");

      // @effect-diagnostics-next-line preferSchemaOverJson:off - asserting on the raw credential file kimi-cli reads.
      const credentials = JSON.parse(
        yield* fs.readFileString(path.join(home, "credentials", "kimi-code.json")),
      );
      expect(credentials.access_token).toBe("access-1");
      expect(credentials.refresh_token).toBe("refresh-1");
      expect(credentials.token_type).toBe("Bearer");
    }),
  );

  it.effect("fails with `denied` when the user rejects the sign-in", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedRequest> = [];
      const httpLayer = makeKimiOAuthHttpLayer(requests, (url) =>
        url.includes("device_authorization")
          ? { status: 200, body: DEVICE_AUTHORIZATION_BODY }
          : { status: 400, body: { error: "access_denied" } },
      );

      const outcome = yield* signInWithKimi({}).pipe(
        Stream.runCollect,
        Effect.flip,
        Effect.provide(httpLayer),
        Effect.forkChild,
      );
      yield* TestClock.adjust("5 seconds");
      const error = yield* Fiber.join(outcome);

      expect(error).toBeInstanceOf(KimiAuthDeniedError);
    }),
  );

  it.effect("stops at the deadline without polling after an oversized interval", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedRequest> = [];
      const httpLayer = makeKimiOAuthHttpLayer(requests, (url) =>
        url.includes("device_authorization")
          ? {
              status: 200,
              body: { ...DEVICE_AUTHORIZATION_BODY, expires_in: 1, interval: 5 },
            }
          : { status: 500, body: { error: "unexpected_poll" } },
      );
      const outcome = yield* signInWithKimi({}).pipe(
        Stream.runCollect,
        Effect.flip,
        Effect.provide(httpLayer),
        Effect.forkChild,
      );

      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(outcome);

      expect(error).toBeInstanceOf(KimiAuthExpiredError);
      expect(requests.filter((request) => request.url.includes("/api/oauth/token"))).toHaveLength(
        0,
      );
    }),
  );

  it.effect("expires by monotonic time after the wall clock moves backward", () =>
    Effect.gen(function* () {
      const testClock = yield* TestClock.testClockWith(Effect.succeed);
      const wallClockMoved = yield* Deferred.make<void>();
      const requests: Array<RecordedRequest> = [];
      const httpLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            const isDeviceAuthorization = request.url.includes("device_authorization");
            requests.push({ url: request.url, params: new URLSearchParams() });
            if (!isDeviceAuthorization) {
              yield* testClock.setTime(-10_000);
              yield* Deferred.succeed(wallClockMoved, undefined);
            }
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                // @effect-diagnostics-next-line preferSchemaOverJson:off - mock wire payloads are free-form test fixtures.
                JSON.stringify(
                  isDeviceAuthorization
                    ? { ...DEVICE_AUTHORIZATION_BODY, expires_in: 2, interval: 1 }
                    : { error: "authorization_pending" },
                ),
                {
                  status: isDeviceAuthorization ? 200 : 400,
                  headers: { "content-type": "application/json" },
                },
              ),
            );
          }),
        ),
      );
      const outcome = yield* signInWithKimi({}).pipe(
        Stream.runCollect,
        Effect.flip,
        Effect.provide(httpLayer),
        Effect.forkChild,
      );

      yield* TestClock.adjust("1 second");
      yield* Deferred.await(wallClockMoved);
      yield* TestClock.adjust("1 second");
      const completed = outcome.pollUnsafe();

      expect(completed).toBeDefined();
      expect(yield* Fiber.join(outcome)).toBeInstanceOf(KimiAuthExpiredError);
      expect(requests.filter((request) => request.url.includes("/api/oauth/token"))).toHaveLength(
        1,
      );
    }),
  );

  it.effect("keeps raw OAuth wire failures out of stable error context", () =>
    Effect.gen(function* () {
      const rawDescription = "x".repeat(10_000);
      const requests: Array<RecordedRequest> = [];
      const httpLayer = makeKimiOAuthHttpLayer(requests, (url) =>
        url.includes("device_authorization")
          ? { status: 200, body: DEVICE_AUTHORIZATION_BODY }
          : {
              status: 400,
              body: { error: "vendor_secret_code", error_description: rawDescription },
            },
      );
      const outcome = yield* signInWithKimi({}).pipe(
        Stream.runCollect,
        Effect.flip,
        Effect.provide(httpLayer),
        Effect.forkChild,
      );

      yield* TestClock.adjust("5 seconds");
      const error = yield* Fiber.join(outcome);

      expect(error).toBeInstanceOf(KimiAuthRequestError);
      expect(error._tag).toBe("KimiAuthRequestError");
      if (error._tag === "KimiAuthRequestError") {
        expect(error.operation).toBe("token-poll");
        expect(error.status).toBe(400);
        expect(error.oauthErrorCode).toBeUndefined();
        expect(error).not.toHaveProperty("detail");
        expect((error.cause as { errorDescription?: string }).errorDescription).toBe(
          rawDescription,
        );
      }
    }),
  );

  it.effect("fails with `expired` when the device authorization lapses", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedRequest> = [];
      const httpLayer = makeKimiOAuthHttpLayer(requests, (url) =>
        url.includes("device_authorization")
          ? { status: 200, body: DEVICE_AUTHORIZATION_BODY }
          : { status: 400, body: { error: "expired_token" } },
      );

      const outcome = yield* signInWithKimi({}).pipe(
        Stream.runCollect,
        Effect.flip,
        Effect.provide(httpLayer),
        Effect.forkChild,
      );
      yield* TestClock.adjust("5 seconds");
      const error = yield* Fiber.join(outcome);

      expect(error).toBeInstanceOf(KimiAuthExpiredError);
    }),
  );
});

it.layer(NodeServices.layer)("writeKimiCredentials", (it) => {
  it.effect("writes atomically into the credentials directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimi-creds-" });

      const credentialsPath = yield* writeKimiCredentials(home, {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 900,
      });

      expect(credentialsPath).toBe(path.join(home, "credentials", "kimi-code.json"));
      // @effect-diagnostics-next-line preferSchemaOverJson:off - asserting on the raw credential file kimi-cli reads.
      const parsed = JSON.parse(yield* fs.readFileString(credentialsPath));
      expect(parsed.access_token).toBe("access-1");

      // No stray temp files left behind.
      const entries = yield* fs.readDirectory(path.join(home, "credentials"));
      expect(entries).toEqual(["kimi-code.json"]);
    }),
  );

  it.effect("uses unique temporary files for concurrent credential writes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimi-concurrent-creds-" });
      const temporaryPaths = yield* Ref.make<ReadonlyArray<string>>([]);
      const recordingFileSystem: FileSystem.FileSystem = {
        ...fs,
        writeFileString: (filePath) =>
          Ref.update(temporaryPaths, (current) => [...current, filePath]),
        rename: () => Effect.void,
      };

      const paths = yield* Effect.all(
        [
          writeKimiCredentials(home, {
            access_token: "access-1",
            refresh_token: "refresh-1",
          }),
          writeKimiCredentials(home, {
            access_token: "access-2",
            refresh_token: "refresh-2",
          }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.provideService(FileSystem.FileSystem, recordingFileSystem));
      const observedTemporaryPaths = yield* Ref.get(temporaryPaths);

      expect(paths[0]).toBe(paths[1]);
      expect(observedTemporaryPaths).toHaveLength(2);
      expect(new Set(observedTemporaryPaths).size).toBe(2);
    }),
  );

  it.effect("removes only the targeted instance credential file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimi-sign-out-" });
      const credentialsPath = yield* writeKimiCredentials(home, {
        access_token: "access-1",
        refresh_token: "refresh-1",
      });
      const siblingPath = path.join(home, "credentials", "keep.txt");
      yield* fs.writeFileString(siblingPath, "keep");

      expect(yield* removeKimiCredentials(home)).toBe(credentialsPath);
      expect(yield* fs.exists(credentialsPath)).toBe(false);
      expect(yield* fs.readFileString(siblingPath)).toBe("keep");
    }),
  );
});
