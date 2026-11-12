import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import { DEFAULT_SERVER_SETTINGS, ServerSettingsError } from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitHubClient from "../shared/definition.ts";
import * as GitHubAppAccess from "./GitHubAppAccess.ts";
import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubRest from "./GitHubRest.ts";

type Reply = { readonly status?: number; readonly body: unknown };
interface Sent {
  readonly host: string;
  readonly path: string;
  readonly form: URLSearchParams;
  /** The bearer token, if any. */
  readonly token: string | undefined;
}

const HOUR = 3_600_000;

const session = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    accessToken: "ghu_current",
    accessTokenExpiresAt: 8 * HOUR,
    refreshToken: "ghr_current",
    refreshTokenExpiresAt: 4_000 * HOUR,
    ...overrides,
  });

/** The whole GitHub request stack over a fake GitHub that `handle` answers. */
function harness(options: {
  readonly handle: (sent: Sent) => Reply;
  readonly signIns?: Record<string, string>;
  readonly tokens?: Record<string, string>;
  /** Without one, the server has no `gh` login to fall back to. */
  readonly ghSignedIn?: boolean;
  /** Makes every settings write fail, as a full disk would. */
  readonly settingsWritesFail?: boolean;
  /** Holds a request open until it completes, to interleave other work with it. */
  readonly gate?: (sent: Sent) => Effect.Effect<void>;
}) {
  const requests: Array<Sent> = [];
  const http = HttpClient.make((request) => {
    const url = new URL(request.url);
    const sent: Sent = {
      host: url.host,
      path: url.pathname,
      form: new URLSearchParams(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
      ),
      token: request.headers["authorization"]?.replace(/^Bearer /, ""),
    };
    return Effect.suspend(() => options.gate?.(sent) ?? Effect.void).pipe(
      Effect.map(() => {
        requests.push(sent);
        const reply = options.handle(sent);
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(reply.body), {
            status: reply.status ?? 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    );
  });
  const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = () =>
    Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: options.ghSignedIn === false ? "" : "gh-token\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  const host = TestSourceControlHost.layer({
    settings: applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      sourceControlHosts: {
        github: { signIns: options.signIns ?? {}, tokens: options.tokens ?? {} },
      },
    }),
    process: { run },
  });
  const failingWrites = Layer.effect(
    SourceControlHost.SourceControlHost,
    Effect.map(Effect.service(SourceControlHost.SourceControlHost), (service) => ({
      ...service,
      settings: {
        ...service.settings,
        update: () =>
          Effect.fail(
            new ServerSettingsError({ settingsPath: "settings.json", operation: "write-file" }),
          ),
      },
    })),
  ).pipe(Layer.provideMerge(host));
  const layer = GitHubAppAccess.layer.pipe(
    Layer.provideMerge(GitHubRest.layerWithDependencies),
    Layer.provideMerge(SourceControlRateLimit.layer),
    Layer.provideMerge(options.settingsWritesFail === true ? failingWrites : host),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
  return { layer, requests };
}

const savedSignIns = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const settings = yield* host.settings.get;
  return readSourceControlHostSettings(GitHubClient.settings, settings.sourceControlHosts.github)
    .signIns;
});

/** A REST read through the request policy, answering with the token it went out with. */
const readUser = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  return yield* api.rest({ host: "github.com", operation: "test", path: "user" });
});

const deviceCode = {
  device_code: "device-1",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

const installedOn = (sent: Sent): Reply =>
  sent.path === "/user/installations"
    ? {
        body: {
          installations: [
            { id: 1, repository_selection: "all", account: { login: "pingdotgg" } },
            { id: 2, repository_selection: "selected", account: { login: "acme" } },
          ],
        },
      }
    : sent.path === "/user/installations/2/repositories"
      ? { body: { repositories: [{ full_name: "acme/one" }] } }
      : { status: 404, body: {} };

beforeEach(() => {
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) vi.stubEnv(name, "");
  vi.stubEnv(GitHubAppSignIn.CLIENT_ID_VARIABLE, "Iv-test-client");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GitHubAppSignIn", () => {
  it.effect("finishes a device-flow sign-in and saves the session", () => {
    const answers = [
      { error: "authorization_pending" },
      { error: "slow_down", interval: 10 },
      {
        access_token: "ghu_new",
        expires_in: 28_800,
        refresh_token: "ghr_new",
        refresh_token_expires_in: 15_897_600,
      },
    ];
    const { layer, requests } = harness({
      handle: (sent) =>
        sent.path === "/login/device/code" ? { body: deviceCode } : { body: answers.shift() },
    });
    return Effect.gen(function* () {
      const signIn = yield* GitHubAppSignIn.GitHubAppSignIn;
      expect(yield* signIn.start("github.com")).toEqual({
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        expiresAt: 900_000,
      });
      const waiting = yield* Effect.forkChild(signIn.wait("github.com"));
      yield* TestClock.adjust("20 seconds");
      yield* Fiber.join(waiting);

      // `slow_down` stretches the interval: polls at 5s, 10s, then 20s.
      const polls = requests.filter((sent) => sent.path === "/login/oauth/access_token");
      expect(polls).toHaveLength(3);
      expect(polls[0]?.form.get("client_id")).toBe("Iv-test-client");
      expect(polls[0]?.form.get("device_code")).toBe("device-1");
      expect(JSON.parse((yield* savedSignIns)["github.com"] ?? "")).toEqual({
        accessToken: "ghu_new",
        accessTokenExpiresAt: 20_000 + 28_800_000,
        refreshToken: "ghr_new",
        refreshTokenExpiresAt: 20_000 + 15_897_600_000,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a sign-in cancelled on GitHub and saves nothing", () => {
    const { layer } = harness({
      handle: (sent) =>
        sent.path === "/login/device/code"
          ? { body: deviceCode }
          : { body: { error: "access_denied" } },
    });
    return Effect.gen(function* () {
      const signIn = yield* GitHubAppSignIn.GitHubAppSignIn;
      yield* signIn.start("github.com");
      const waiting = yield* Effect.forkChild(Effect.flip(signIn.wait("github.com")));
      yield* TestClock.adjust("5 seconds");
      expect((yield* Fiber.join(waiting)).reason).toBe("denied");
      expect(yield* savedSignIns).toEqual({});
    }).pipe(Effect.provide(layer));
  });

  it.effect("expires a code nobody entered", () => {
    const { layer } = harness({
      handle: (sent) =>
        sent.path === "/login/device/code"
          ? { body: { ...deviceCode, expires_in: 12 } }
          : { body: { error: "authorization_pending" } },
    });
    return Effect.gen(function* () {
      const signIn = yield* GitHubAppSignIn.GitHubAppSignIn;
      yield* signIn.start("github.com");
      const waiting = yield* Effect.forkChild(Effect.flip(signIn.wait("github.com")));
      yield* TestClock.adjust("15 seconds");
      expect((yield* Fiber.join(waiting)).reason).toBe("expired");
    }).pipe(Effect.provide(layer));
  });

  it.effect("cancels a sign-in so approving the code afterwards saves nothing", () => {
    const { layer, requests } = harness({
      handle: (sent) =>
        sent.path === "/login/device/code"
          ? { body: deviceCode }
          : { body: { access_token: "ghu_new", expires_in: 28_800 } },
    });
    return Effect.gen(function* () {
      const signIn = yield* GitHubAppSignIn.GitHubAppSignIn;
      yield* signIn.start("github.com");
      const waiting = yield* Effect.forkChild(Effect.flip(signIn.wait("github.com")));
      yield* signIn.cancel("github.com");
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(waiting)).reason).toBe("cancelled");
      expect(requests.map((sent) => sent.path)).toEqual(["/login/device/code"]);
      expect(yield* savedSignIns).toEqual({});
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses hosts the app is not registered on", () => {
    const { layer, requests } = harness({ handle: () => ({ body: {} }) });
    return Effect.gen(function* () {
      const signIn = yield* GitHubAppSignIn.GitHubAppSignIn;
      expect((yield* Effect.flip(signIn.start("ghe.acme.test"))).reason).toBe("unsupported");
      expect((yield* Effect.flip(signIn.wait("github.com"))).reason).toBe("not-started");
      expect(requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does nothing with the app when the server has no client ID", () => {
    vi.stubEnv(GitHubAppSignIn.CLIENT_ID_VARIABLE, "");
    const { layer, requests } = harness({
      signIns: { "github.com": session() },
      handle: () => ({ body: { login: "octocat" } }),
    });
    return Effect.gen(function* () {
      const signIn = yield* GitHubAppSignIn.GitHubAppSignIn;
      expect(signIn.enabled).toBe(false);
      expect((yield* Effect.flip(signIn.start("github.com"))).reason).toBe("unsupported");
      expect(yield* (yield* GitHubAppAccess.GitHubAppAccess).reach("github.com", "acme/one")).toBe(
        "signed-out",
      );
      // A session saved while it was on stays put but is not used.
      yield* readUser;
      expect(requests.map((sent) => sent.token)).toEqual(["gh-token"]);
      expect(Object.keys(yield* savedSignIns)).toEqual(["github.com"]);
    }).pipe(Effect.provide(layer));
  });

  describe("refresh", () => {
    const refreshed = {
      access_token: "ghu_refreshed",
      expires_in: 28_800,
      refresh_token: "ghr_refreshed",
      refresh_token_expires_in: 15_897_600,
    };

    it.effect("refreshes an expiring token once for concurrent requests", () => {
      const { layer, requests } = harness({
        signIns: { "github.com": session({ accessTokenExpiresAt: 3 * 60_000 }) },
        handle: () => ({ body: refreshed }),
      });
      return Effect.gen(function* () {
        const signIn = yield* GitHubAppSignIn.GitHubAppSignIn;
        const tokens = yield* Effect.all([signIn.token("github.com"), signIn.token("github.com")], {
          concurrency: "unbounded",
        });
        expect(tokens).toEqual([Option.some("ghu_refreshed"), Option.some("ghu_refreshed")]);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.form.get("grant_type")).toBe("refresh_token");
        expect(requests[0]?.form.get("refresh_token")).toBe("ghr_current");
      }).pipe(Effect.provide(layer));
    });

    it.effect("refreshes a token GitHub refused, and only that one", () => {
      const { layer, requests } = harness({
        signIns: { "github.com": session() },
        handle: () => ({ body: refreshed }),
      });
      return Effect.gen(function* () {
        const signIn = yield* GitHubAppSignIn.GitHubAppSignIn;
        yield* signIn.invalidate("github.com", "gh-token");
        expect(yield* signIn.token("github.com")).toEqual(Option.some("ghu_current"));
        yield* signIn.invalidate("github.com", "ghu_current");
        expect(yield* signIn.token("github.com")).toEqual(Option.some("ghu_refreshed"));
        expect(requests).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    });

    it.effect("signs out when GitHub refuses the refresh token", () => {
      const { layer } = harness({
        signIns: { "github.com": session({ accessTokenExpiresAt: 0 }) },
        handle: () => ({ body: { error: "bad_refresh_token" } }),
      });
      return Effect.gen(function* () {
        const signIn = yield* GitHubAppSignIn.GitHubAppSignIn;
        expect(yield* signIn.token("github.com")).toEqual(Option.none());
        expect(yield* savedSignIns).toEqual({});
      }).pipe(Effect.provide(layer));
    });

    it.effect("keeps the session when a refresh fails for another reason", () => {
      const { layer } = harness({
        signIns: { "github.com": session({ accessTokenExpiresAt: 0 }) },
        handle: () => ({ body: { error: "unauthorized_client" } }),
      });
      return Effect.gen(function* () {
        const signIn = yield* GitHubAppSignIn.GitHubAppSignIn;
        expect((yield* Effect.flip(signIn.token("github.com")))._tag).toBe("GitHubAppSessionError");
        expect(Object.keys(yield* savedSignIns)).toEqual(["github.com"]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("serves the still-valid token when a refresh ahead of expiry fails", () => {
      const { layer } = harness({
        signIns: { "github.com": session({ accessTokenExpiresAt: 3 * 60_000 }) },
        handle: () => ({ status: 502, body: {} }),
      });
      return Effect.gen(function* () {
        const signIn = yield* GitHubAppSignIn.GitHubAppSignIn;
        expect(yield* signIn.token("github.com")).toEqual(Option.some("ghu_current"));
      }).pipe(Effect.provide(layer));
    });

    it.effect("serves a refreshed token GitHub issued even when saving it fails", () => {
      const { layer } = harness({
        signIns: { "github.com": session({ accessTokenExpiresAt: 3 * 60_000 }) },
        settingsWritesFail: true,
        handle: () => ({ body: refreshed }),
      });
      return Effect.gen(function* () {
        const signIn = yield* GitHubAppSignIn.GitHubAppSignIn;
        const pending = yield* Effect.forkChild(signIn.token("github.com"));
        yield* TestClock.adjust("1 second");
        expect(yield* Fiber.join(pending)).toEqual(Option.some("ghu_refreshed"));
      }).pipe(Effect.provide(layer));
    });

    it.effect("does not bring a session back that was signed out while it refreshed", () => {
      const released = Deferred.makeUnsafe<void>();
      const requested = Deferred.makeUnsafe<void>();
      const { layer } = harness({
        signIns: { "github.com": session({ accessTokenExpiresAt: 0 }) },
        gate: () =>
          Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(released))),
        handle: () => ({ body: refreshed }),
      });
      return Effect.gen(function* () {
        const signIn = yield* GitHubAppSignIn.GitHubAppSignIn;
        const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
        const refreshing = yield* Effect.forkChild(signIn.token("github.com"));
        yield* Deferred.await(requested);
        yield* settings.update({ sourceControlHosts: { github: { signIns: {} } } });
        yield* Deferred.succeed(released, undefined);
        expect(yield* Fiber.join(refreshing)).toEqual(Option.none());
        expect(yield* savedSignIns).toEqual({});
      }).pipe(Effect.provide(layer));
    });
  });
});

describe("GitHub requests with the app sign-in", () => {
  const answerUser = (sent: Sent): Reply => ({ body: { login: sent.token ?? "anonymous" } });

  it.effect("uses the app before GH_TOKEN and gh, and a saved token before the app", () => {
    vi.stubEnv("GH_TOKEN", "from-env");
    const signedIn = harness({ signIns: { "github.com": session() }, handle: answerUser });
    const withToken = harness({
      signIns: { "github.com": session() },
      tokens: { "github.com": "saved-pat" },
      handle: answerUser,
    });
    return Effect.gen(function* () {
      yield* readUser.pipe(Effect.provide(signedIn.layer));
      yield* readUser.pipe(Effect.provide(withToken.layer));
      expect(signedIn.requests.map((sent) => sent.token)).toEqual(["ghu_current"]);
      expect(withToken.requests.map((sent) => sent.token)).toEqual(["saved-pat"]);
    });
  });

  it.effect("asks again with the user's own credential when the app gets not found", () => {
    const { layer, requests } = harness({
      signIns: { "github.com": session() },
      handle: (sent) =>
        sent.token === "ghu_current" ? { status: 404, body: {} } : answerUser(sent),
    });
    return Effect.gen(function* () {
      const response = yield* readUser;
      expect(JSON.parse(response.body)).toEqual({ login: "gh-token" });
      expect(requests.map((sent) => sent.token)).toEqual(["ghu_current", "gh-token"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks again when GitHub says the resource is not accessible by integration", () => {
    const { layer, requests } = harness({
      signIns: { "github.com": session() },
      handle: (sent) =>
        sent.token === "ghu_current"
          ? { status: 403, body: { message: "Resource not accessible by integration" } }
          : answerUser(sent),
    });
    return Effect.gen(function* () {
      yield* readUser;
      expect(requests.map((sent) => sent.token)).toEqual(["ghu_current", "gh-token"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the app's answer when there is no other credential", () => {
    const { layer, requests } = harness({
      signIns: { "github.com": session() },
      ghSignedIn: false,
      handle: () => ({ status: 404, body: {} }),
    });
    return Effect.gen(function* () {
      expect((yield* Effect.flip(readUser))._tag).toBe("GitHubApiNotFoundError");
      expect(requests.map((sent) => sent.token)).toEqual(["ghu_current"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not ask again after the user's own credential is refused", () => {
    const { layer, requests } = harness({ handle: () => ({ status: 404, body: {} }) });
    return Effect.gen(function* () {
      expect((yield* Effect.flip(readUser))._tag).toBe("GitHubApiNotFoundError");
      expect(requests.map((sent) => sent.token)).toEqual(["gh-token"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses the gh login while the app session cannot refresh, and keeps the session", () => {
    const { layer, requests } = harness({
      signIns: { "github.com": session({ accessTokenExpiresAt: 0 }) },
      handle: (sent) => (sent.host === "github.com" ? { status: 502, body: {} } : answerUser(sent)),
    });
    return Effect.gen(function* () {
      yield* readUser;
      expect(requests.filter((sent) => sent.path === "/user").map((sent) => sent.token)).toEqual([
        "gh-token",
      ]);
      expect(Object.keys(yield* savedSignIns)).toEqual(["github.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refreshes the app token after GitHub rejects it", () => {
    let rejected = false;
    const { layer, requests } = harness({
      signIns: { "github.com": session() },
      handle: (sent) => {
        if (sent.path === "/login/oauth/access_token") {
          return { body: { access_token: "ghu_refreshed", expires_in: 28_800 } };
        }
        if (sent.token === "ghu_current" && !rejected) {
          rejected = true;
          return { status: 401, body: {} };
        }
        return answerUser(sent);
      },
    });
    return Effect.gen(function* () {
      expect((yield* Effect.flip(readUser))._tag).toBe("GitHubApiAuthenticationError");
      yield* readUser;
      expect(requests.map((sent) => sent.token ?? sent.path)).toEqual([
        "ghu_current",
        "/login/oauth/access_token",
        "ghu_refreshed",
      ]);
    }).pipe(Effect.provide(layer));
  });
});

describe("GitHubAppAccess", () => {
  it.effect("reads the installations as the app, even with a saved token", () => {
    const { layer, requests } = harness({
      signIns: { "github.com": session() },
      tokens: { "github.com": "saved-pat" },
      handle: installedOn,
    });
    return Effect.gen(function* () {
      const access = yield* GitHubAppAccess.GitHubAppAccess;
      expect(yield* access.reach("github.com", "pingdotgg/t3code")).toBe("covered");
      expect(yield* access.reach("github.com", "acme/one")).toBe("covered");
      expect(yield* access.reach("github.com", "acme/two")).toBe("not-covered");
      expect(yield* access.reach("github.com", "https://github.com/Acme/One.git")).toBe("covered");
      expect(new Set(requests.map((sent) => sent.token))).toEqual(new Set(["ghu_current"]));
      // One read of the installations serves every repository until it goes stale.
      expect(requests.filter((sent) => sent.path === "/user/installations")).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("answers signed out without a session, and covered while GitHub fails", () => {
    const signedOut = harness({ handle: installedOn });
    const failing = harness({
      signIns: { "github.com": session() },
      handle: () => ({ status: 502, body: {} }),
    });
    return Effect.gen(function* () {
      expect(
        yield* Effect.flatMap(Effect.service(GitHubAppAccess.GitHubAppAccess), (access) =>
          access.reach("github.com", "acme/one"),
        ).pipe(Effect.provide(signedOut.layer)),
      ).toBe("signed-out");
      const answers = yield* Effect.gen(function* () {
        const access = yield* GitHubAppAccess.GitHubAppAccess;
        return [
          yield* access.reach("github.com", "acme/one"),
          yield* access.reach("github.com", "acme/two"),
        ];
      }).pipe(Effect.provide(failing.layer));
      expect(answers).toEqual(["covered", "covered"]);
      // A failed read is kept briefly instead of asked again per request.
      expect(failing.requests).toHaveLength(1);
    });
  });

  it.effect("gives work on a repository the app cannot reach the user's credential", () => {
    const { layer } = harness({ signIns: { "github.com": session() }, handle: installedOn });
    return Effect.gen(function* () {
      const access = yield* GitHubAppAccess.GitHubAppAccess;
      const tokenFor = (repository: string) =>
        access
          .credentialFor("github.com", repository)
          .pipe(Effect.map((held) => Redacted.value(held.token)));
      expect(yield* tokenFor("pingdotgg/t3code")).toBe("ghu_current");
      expect(yield* tokenFor("someone/else")).toBe("gh-token");
    }).pipe(Effect.provide(layer));
  });

  it.effect("pins the user's credential while the app's reach is unknown", () => {
    const failing = (sent: Sent): Reply =>
      sent.path.startsWith("/user/installations") ? { status: 502, body: {} } : { body: {} };
    const withGh = harness({ signIns: { "github.com": session() }, handle: failing });
    const appOnly = harness({
      signIns: { "github.com": session() },
      ghSignedIn: false,
      handle: failing,
    });
    const tokenFor = Effect.flatMap(Effect.service(GitHubAppAccess.GitHubAppAccess), (access) =>
      access
        .credentialFor("github.com", "pingdotgg/t3code")
        .pipe(Effect.map((held) => Redacted.value(held.token))),
    );
    return Effect.gen(function* () {
      expect(yield* tokenFor.pipe(Effect.provide(withGh.layer))).toBe("gh-token");
      expect(yield* tokenFor.pipe(Effect.provide(appOnly.layer))).toBe("ghu_current");
    });
  });

  it.effect("names the account the app sign-in acts as", () => {
    const { layer } = harness({
      signIns: { "github.com": session() },
      tokens: { "github.com": "saved-pat" },
      handle: (sent) => ({ body: { login: sent.token === "ghu_current" ? "octocat" : "other" } }),
    });
    return Effect.gen(function* () {
      expect(yield* (yield* GitHubAppAccess.GitHubAppAccess).viewer("github.com")).toBe("octocat");
    }).pipe(Effect.provide(layer));
  });
});
