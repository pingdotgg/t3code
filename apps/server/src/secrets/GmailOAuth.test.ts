import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { HttpRouter } from "effect/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { callbackPath, GmailOAuth, makeGmailFlows, manageGmailVault } from "./GmailOAuth.ts";
import { routeLayer } from "./GmailOAuthHttp.ts";
import { manageLocalVault } from "./LocalVault.ts";
import { setVaultPin } from "./VaultAccess.ts";

const target = { sessionId: "owner-session", name: "mail", title: "Work mail" };
const redirectUri = `https://environment.example.test${callbackPath}`;
const grant = {
  clientId: "123-test.apps.googleusercontent.com",
  refreshToken: "synthetic-grant",
  account: "test@example.test",
};
const client = {
  clientId: grant.clientId,
  clientSecret: "synthetic-client-secret",
  redirectUri,
  revision: "first",
};
const code = "synthetic-google-code";
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- HTTP handler tests await native Promises alongside the Effect state and storage boundaries.
  Effect.runPromise(effect);

function fixture(expectedSecret = client.clientSecret) {
  const exchanges: Array<{ code: string; verifier: string }> = [];
  const flows = makeGmailFlows({
    exchange: (input, registration) =>
      Effect.sync(() => {
        expect(registration.clientId).toBe(grant.clientId);
        expect(registration.redirectUri).toBe(redirectUri);
        expect(registration.clientSecret === expectedSecret).toBe(true);
        exchanges.push(input);
        return grant;
      }),
  });
  const saved: Array<{ title: string; value: typeof grant }> = [];
  const save = (title: string, value: typeof grant) =>
    Effect.sync(() => {
      saved.push({ title, value });
    });
  const start = (entry = target) => run(flows.start(entry, client));
  const finish = (
    id: string,
    pin: Effect.Effect<void, { message: string }> = Effect.void,
    sessionId = target.sessionId,
    name = target.name,
  ) => flows.finish(sessionId, name, id, () => pin.pipe(Effect.as(client)), save);
  return { flows, exchanges, saved, start, finish };
}

const failure = <A>(effect: Effect.Effect<A, { message: string }>) => run(Effect.flip(effect));
const googleState = (url: string) => new URL(url).searchParams.get("state")!;

describe("Gmail consent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a Google callback without an app session, then exchanges once with the original PKCE verifier only after PIN", async () => {
    const { flows, exchanges, saved, start, finish } = fixture();
    const { handler, dispose } = HttpRouter.toWebHandler(
      routeLayer.pipe(Layer.provideMerge(Layer.succeed(GmailOAuth, flows))),
      { disableLogger: true },
    );
    try {
      const { url, flowId } = await start();
      const consent = new URL(url);
      const params = consent.searchParams;
      const state = googleState(url);
      expect(consent.origin + consent.pathname).toBe(
        "https://accounts.google.com/o/oauth2/v2/auth",
      );
      expect(Object.fromEntries(params)).toMatchObject({
        client_id: grant.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "false",
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        code_challenge_method: "S256",
      });
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(flowId).not.toBe(state);
      expect(url).not.toContain(flowId);
      expect(params.has("client_secret")).toBe(false);
      expect(url).not.toContain(client.clientSecret);
      expect(params.has("revision")).toBe(false);
      expect((await failure(finish(flowId))).message).toMatch(/complete consent/i);
      const callback = () =>
        handler(new Request(`${redirectUri}?${new URLSearchParams({ state, code })}`));
      const response = await callback();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("location")).toBeNull();
      const text = await response.text();
      expect(text).toMatch(/Google approval received/i);
      expect(text).toMatch(/Finish connection/i);
      expect(text).not.toContain(state);
      expect(text).not.toContain(code);
      const replayed = await callback();
      expect(replayed.status).toBe(400);
      expect(await replayed.text()).toMatch(/expired.*already used.*replaced/i);
      for (const query of ["", "?state=unknown&code=private-unused-code"]) {
        const inactive = await handler(new Request(`${redirectUri}${query}`));
        expect(inactive.status).toBe(400);
        const message = await inactive.text();
        expect(message).toMatch(/expired.*already used.*replaced/i);
        expect(message).not.toContain("private-unused-code");
      }
      expect(await failure(finish(flowId, Effect.void, "someone-else"))).toEqual(
        await failure(finish("unknown")),
      );
      expect(await failure(finish(flowId, Effect.void, target.sessionId, "other-entry"))).toEqual(
        await failure(finish("unknown")),
      );
      expect(
        await failure(finish(flowId, Effect.fail({ message: "Incorrect vault PIN." }))),
      ).toEqual({
        message: "Incorrect vault PIN.",
      });
      expect(exchanges).toEqual([]);
      expect(saved).toEqual([]);
      await run(finish(flowId));
      expect(exchanges).toHaveLength(1);
      const exchange = exchanges[0]!;
      expect(exchange.code).toBe(code);
      expect(url).not.toContain(exchange.verifier);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(exchange.verifier),
      );
      expect(Buffer.from(digest).toString("base64url")).toBe(params.get("code_challenge"));
      expect(saved).toEqual([{ title: target.title, value: grant }]);
      expect((await failure(finish(flowId))).message).toMatch(/start the connection again/i);
      expect(exchanges).toHaveLength(1);
    } finally {
      await dispose();
      flows.close();
    }
  });

  it.each([
    "error=access_denied",
    "code=one&code=two",
    "code=",
    "code=%00",
    "error=denied&code=val",
  ])("consumes a denied or malformed callback without an exchange: %s", async (query: string) => {
    const { flows, start, finish, exchanges, saved } = fixture();
    const { handler, dispose } = HttpRouter.toWebHandler(
      routeLayer.pipe(Layer.provideMerge(Layer.succeed(GmailOAuth, flows))),
      { disableLogger: true },
    );
    try {
      const { url, flowId } = await start();
      const state = googleState(url);
      const privateDetail = "private-google-error-detail";
      const response = await handler(
        new Request(`${redirectUri}?state=${state}&${query}&error_description=${privateDetail}`),
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toMatch(/Google did not approve Gmail access/i);
      expect(text).not.toContain(state);
      expect(text).not.toContain(query);
      expect(text).not.toContain(privateDetail);
      const replayed = await handler(
        new Request(`${redirectUri}?${new URLSearchParams({ state, code })}`),
      );
      expect(replayed.status).toBe(400);
      expect(await replayed.text()).toMatch(/expired.*already used.*replaced/i);
      const error = await failure(finish(flowId));
      expect(error.message).not.toContain(state);
      expect(error.message).not.toContain(flowId);
      expect(exchanges).toEqual([]);
      expect(saved).toEqual([]);
    } finally {
      await dispose();
      flows.close();
    }
  });

  it("rejects ambiguous state, superseded enrollments and codes past their deadline", async () => {
    const { flows, exchanges, saved, start, finish } = fixture();
    try {
      const first = await start();
      const second = await start();
      const state = googleState(second.url);
      expect(flows.receive(new URLSearchParams({ state: googleState(first.url), code }))).toBe(
        "inactive",
      );
      expect(flows.receive(new URLSearchParams(`state=${state}&state=${state}&code=x`))).toBe(
        "inactive",
      );
      expect(flows.receive(new URLSearchParams({ state, code }))).toBe("accepted");
      const expiring = await start({ ...target, name: "another-mail" });
      vi.spyOn(performance, "now").mockReturnValue(performance.now() + 11 * 60_000);
      expect(flows.receive(new URLSearchParams({ state: googleState(expiring.url), code }))).toBe(
        "inactive",
      );
      expect((await failure(finish(second.flowId))).message).toMatch(/start the connection again/i);
      expect(exchanges).toEqual([]);
      expect(saved).toEqual([]);
    } finally {
      flows.close();
    }
  });

  it("bounds outstanding flows without evicting another session and releases capacity on cancellation", async () => {
    const { flows } = fixture();
    try {
      for (let n = 0; n < 32; n++) {
        await run(flows.start({ ...target, name: `mail${n}` }, client));
      }
      expect((await failure(flows.start(target, client))).message).toMatch(/too many/i);
      flows.cancelEntry("mail0");
      expect((await run(flows.start(target, client))).flowId).toBeTruthy();
    } finally {
      flows.close();
    }
  });

  it("preserves storage errors and never reuses a spent code", async () => {
    const { flows, start, finish, exchanges } = fixture();
    try {
      const { url, flowId } = await start();
      expect(flows.receive(new URLSearchParams({ state: googleState(url), code }))).toBe(
        "accepted",
      );
      const error = await failure(
        flows.finish(
          target.sessionId,
          target.name,
          flowId,
          () => Effect.succeed(client),
          () => Effect.fail({ message: "The vault entry title has changed." }),
        ),
      );
      expect(error.message).toMatch(/title has changed.*start the Gmail connection again/i);
      await failure(finish(flowId));
      expect(exchanges).toHaveLength(1);
    } finally {
      flows.close();
    }
  });
});

it("rejects registration rotation before exchange and during save, and disconnects locally without removing the entry", async () => {
  const { flows, exchanges } = fixture("rotated-at-exchange");
  const bytes = new Map<string, Uint8Array>();
  const write = (key: string, value: Uint8Array) =>
    Effect.sync(() => {
      bytes.set(key, value.slice());
    });
  // A memory-only store and directory listing; never touch a host path, mailbox or keyring.
  const store = ServerSecretStore.of({
    directory: "/memory",
    storageMode: "linux-keyring-aes256gcm",
    get: (key) => Effect.sync(() => Option.fromNullishOr(bytes.get(key)?.slice())),
    set: write,
    create: (key, value) =>
      bytes.has(key) ? Effect.die("unexpected replacement") : write(key, value),
    remove: (key) =>
      Effect.sync(() => {
        bytes.delete(key);
      }),
    getOrCreateRandom: () => Effect.die("unexpected key generation"),
  });
  const directory = FileSystem.layerNoop({
    readDirectory: () => Effect.sync(() => Array.from(bytes.keys(), (name) => `${name}.bin`)),
  });
  const options = { canSetInitialPin: true };
  const pin = "734825";
  const configure = (clientSecret: string, name = target.name, title = target.title) =>
    manageLocalVault(
      store,
      {
        action: "gmail-configure",
        name,
        title,
        clientId: client.clientId,
        clientSecret: Redacted.make(clientSecret),
        redirectUri,
        pin: Redacted.make(pin),
      },
      options,
    );
  const start = (service: GmailOAuth["Service"]) =>
    manageGmailVault(
      service,
      target.sessionId,
      store,
      {
        action: "gmail-start",
        name: target.name,
        title: target.title,
      },
      options,
    );
  const finish = (service: GmailOAuth["Service"], flowId: string, attempt: string) =>
    manageGmailVault(
      service,
      target.sessionId,
      store,
      {
        action: "gmail-finish",
        name: target.name,
        flowId,
        pin: Redacted.make(attempt),
      },
      options,
    );
  const rotateDuringExchange = makeGmailFlows({
    exchange: () =>
      configure("rotated-at-exchange").pipe(
        Effect.provide(directory),
        Effect.map((result) => {
          expect(result.error).toBeNull();
          return grant;
        }),
      ),
  });
  try {
    await run(
      Effect.gen(function* () {
        yield* setVaultPin(store, Redacted.make(pin), undefined, true);
        expect(
          (yield* configure("synthetic-other-secret", "other", "Other mail")).error,
        ).toBeNull();
        expect((yield* start(flows)).gmailAuthorization).toBeUndefined();
        expect((yield* configure(client.clientSecret)).error).toBeNull();
        for (const config of [
          {},
          { HYAKKI_GMAIL_REDIRECT_URI: `https://other.example.test${callbackPath}` },
        ]) {
          const rejected = yield* start(flows).pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
          );
          expect(rejected.gmailAuthorization).toBeUndefined();
          expect(rejected.error).toMatch(/callback|redirect URI/i);
        }
        const stale = (yield* start(flows)).gmailAuthorization!;
        expect(flows.receive(new URLSearchParams({ state: googleState(stale.url), code }))).toBe(
          "accepted",
        );
        expect((yield* configure("rotated-before-exchange")).error).toBeNull();
        expect((yield* finish(flows, stale.flowId, pin)).error).toMatch(/changed/i);
        expect(exchanges).toHaveLength(0);

        const pending = (yield* start(rotateDuringExchange)).gmailAuthorization!;
        expect(
          rotateDuringExchange.receive(
            new URLSearchParams({ state: googleState(pending.url), code }),
          ),
        ).toBe("accepted");
        expect((yield* finish(rotateDuringExchange, pending.flowId, pin)).error).not.toBeNull();
        const listed = yield* manageLocalVault(store, { action: "list" }, options);
        expect(listed.entries?.some((entry) => entry.gmailAccount)).toBe(false);

        const started = yield* start(flows);
        expect(started.error).toBeNull();
        const { flowId, url } = started.gmailAuthorization!;
        expect(flows.receive(new URLSearchParams({ state: googleState(url), code }))).toBe(
          "accepted",
        );
        expect((yield* finish(flows, flowId, "888888")).error).toMatch(/incorrect vault PIN/i);
        expect(exchanges).toHaveLength(0);
        const result = yield* finish(flows, flowId, pin);
        expect(result.error).toBeNull();
        expect(result.entries?.find((entry) => entry.name === target.name)).toMatchObject({
          title: target.title,
          kind: "gmail",
          gmailAccount: grant.account,
          fields: [],
        });
        expect(
          result.entries?.find((entry) => entry.name === "other")?.gmailAccount,
        ).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain(grant.refreshToken);
        expect(JSON.stringify(result)).not.toContain("rotated-at-exchange");
        expect(exchanges).toHaveLength(1);
        const disconnect = (attempt: string) =>
          manageGmailVault(
            undefined,
            target.sessionId,
            store,
            {
              action: "gmail-disconnect",
              name: target.name,
              pin: Redacted.make(attempt),
            },
            options,
          );
        expect((yield* disconnect("888888")).error).toMatch(/incorrect vault PIN/i);
        const disconnected = yield* disconnect(pin).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
        );
        expect(disconnected.gmailRedirectUri).toBeUndefined();
        expect(disconnected.error).toBeNull();
        expect(disconnected.entries?.find((entry) => entry.name === target.name)).toMatchObject({
          name: target.name,
          gmailClient: { clientId: client.clientId, redirectUri },
        });
        expect(disconnected.entries?.some((entry) => entry.gmailAccount)).toBe(false);
        expect(exchanges).toHaveLength(1);
      }).pipe(
        Effect.provide(
          Layer.merge(
            directory,
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { HYAKKI_GMAIL_REDIRECT_URI: redirectUri } }),
            ),
          ),
        ),
      ),
    );
  } finally {
    flows.close();
    rotateDuringExchange.close();
  }
});
