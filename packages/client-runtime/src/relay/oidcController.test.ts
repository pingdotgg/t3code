import { base64UrlEncode } from "@t3tools/shared/oidc";
import { describe, expect, it } from "vite-plus/test";

import { createOidcController, type KeyValueStore } from "./oidcController.ts";

const ISSUER = "https://sso.example.com/realms/t3";
const REDIRECT_URI = "https://app.example.com/oidc/callback";

const memoryStore = (): KeyValueStore & { readonly entries: Map<string, string> } => {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
};

const encodeJson = (value: unknown) =>
  base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
const idToken = (claims: Record<string, unknown>) =>
  `${encodeJson({ alg: "ES256" })}.${encodeJson({
    sub: "alice",
    iss: ISSUER,
    email: "alice@example.com",
    ...claims,
  })}.signature`;

interface Harness {
  readonly controller: ReturnType<typeof createOidcController>;
  readonly sessions: ReturnType<typeof memoryStore>;
  readonly pending: ReturnType<typeof memoryStore>;
  readonly navigations: Array<string>;
  readonly tokenRequests: Array<URLSearchParams>;
  clock: number;
  tokenReply: () => Response;
}

function makeHarness(): Harness {
  const sessions = memoryStore();
  const pending = memoryStore();
  const harness: Harness = {
    sessions,
    pending,
    navigations: [],
    tokenRequests: [],
    clock: 1_000_000,
    tokenReply: () => Response.json({}, { status: 500 }),
    controller: undefined as never,
  };
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/auth`,
        token_endpoint: `${ISSUER}/token`,
      });
    }
    harness.tokenRequests.push(new URLSearchParams(String(init?.body)));
    return harness.tokenReply();
  };
  return Object.assign(harness, {
    controller: createOidcController({
      config: { issuer: ISSUER, clientId: "t3-code" },
      redirectUri: REDIRECT_URI,
      sessions,
      pending,
      navigate: (url) => harness.navigations.push(url),
      now: () => harness.clock,
      fetch: fetchImpl as typeof fetch,
    }),
  });
}

/** Signs in through the redirect and callback, with the provider answering `tokens`. */
async function signInWith(harness: Harness, claims: Record<string, unknown> = {}) {
  await harness.controller.signIn("/settings/connections");
  const authorize = new URL(harness.navigations[0]!);
  harness.tokenReply = () =>
    Response.json({
      id_token: idToken({
        exp: harness.clock / 1000 + 3600,
        nonce: authorize.searchParams.get("nonce"),
        ...claims,
      }),
      refresh_token: "refresh-1",
    });
  const callback = `${REDIRECT_URI}?code=code-1&state=${authorize.searchParams.get("state")}`;
  return { authorize, returnTo: await harness.controller.completeSignIn(callback) };
}

describe("sign-in redirect", () => {
  it("sends the user to the provider with PKCE, state and a nonce", async () => {
    const harness = makeHarness();
    await harness.controller.signIn("/settings/connections");

    const url = new URL(harness.navigations[0]!);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/auth`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "t3-code",
      redirect_uri: REDIRECT_URI,
      code_challenge_method: "S256",
    });
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("nonce")).toBeTruthy();
  });

  it("completes the callback, stores the session and returns to the page that asked", async () => {
    const harness = makeHarness();
    const seen: Array<string | null> = [];
    harness.controller.addListener((resources) => seen.push(resources.user?.id ?? null));

    const { returnTo } = await signInWith(harness);

    expect(returnTo).toBe("/settings/connections");
    expect(harness.tokenRequests[0]?.get("grant_type")).toBe("authorization_code");
    expect(harness.tokenRequests[0]?.get("code")).toBe("code-1");
    expect(harness.controller.getSnapshot()).toEqual({
      userId: "alice",
      label: "alice@example.com",
    });
    expect(seen).toEqual([null, "alice"]);
    expect(harness.pending.entries.size).toBe(0);
  });

  it("signs in through an in-app browser that hands back the redirect URL", async () => {
    const harness = makeHarness();

    await harness.controller.signInWithPrompt(async (authorizeUrl) => {
      const url = new URL(authorizeUrl);
      harness.tokenReply = () =>
        Response.json({
          id_token: idToken({
            exp: harness.clock / 1000 + 3600,
            nonce: url.searchParams.get("nonce"),
          }),
          refresh_token: "refresh-1",
        });
      return `${REDIRECT_URI}?code=code-1&state=${url.searchParams.get("state")}`;
    });

    expect(harness.controller.getSnapshot().userId).toBe("alice");
    expect(harness.navigations).toEqual([]);
  });

  it.each([
    ["a state this tab never issued", (state: string) => `?code=c&state=${state}x`],
    ["a refusal from the provider", () => "?error=access_denied"],
    ["no code", (state: string) => `?state=${state}`],
  ])("rejects %s without asking for tokens", async (_name, query) => {
    const harness = makeHarness();
    await harness.controller.signIn();
    const state = new URL(harness.navigations[0]!).searchParams.get("state")!;

    await expect(
      harness.controller.completeSignIn(`${REDIRECT_URI}${query(state)}`),
    ).rejects.toThrow();

    expect(harness.tokenRequests).toEqual([]);
    expect(harness.controller.getSnapshot().userId).toBeNull();
    // The request is spent, so replaying the callback cannot succeed either.
    expect(harness.pending.entries.size).toBe(0);
  });

  it("never returns to another origin", async () => {
    const harness = makeHarness();
    await harness.controller.signIn("https://evil.example.com/");
    const authorize = new URL(harness.navigations[0]!);
    harness.tokenReply = () =>
      Response.json({
        id_token: idToken({ exp: 2_000_000, nonce: authorize.searchParams.get("nonce") }),
      });

    expect(
      await harness.controller.completeSignIn(
        `${REDIRECT_URI}?code=c&state=${authorize.searchParams.get("state")}`,
      ),
    ).toBe("/");
  });
});

describe("tokens", () => {
  it("returns the stored ID token while it has a minute to spare", async () => {
    const harness = makeHarness();
    await signInWith(harness);
    const requests = harness.tokenRequests.length;

    const token = await harness.controller.getToken();

    expect(token).toBeTruthy();
    expect(harness.tokenRequests).toHaveLength(requests);
  });

  it("refreshes an expiring token once for concurrent callers", async () => {
    const harness = makeHarness();
    await signInWith(harness);
    harness.clock += 3600 * 1000;
    harness.tokenReply = () =>
      Response.json({ id_token: idToken({ exp: harness.clock / 1000 + 3600 }) });
    const before = harness.tokenRequests.length;

    const tokens = await Promise.all([
      harness.controller.getToken(),
      harness.controller.getToken(),
    ]);

    expect(tokens[0]).toBe(tokens[1]);
    expect(harness.tokenRequests.slice(before)).toHaveLength(1);
    expect(harness.tokenRequests.at(-1)?.get("grant_type")).toBe("refresh_token");
    expect(harness.tokenRequests.at(-1)?.get("refresh_token")).toBe("refresh-1");
  });

  it("signs out when the provider ends the session, but keeps it through an outage", async () => {
    const harness = makeHarness();
    await signInWith(harness);
    harness.clock += 3600 * 1000;

    harness.tokenReply = () => Response.json({}, { status: 503 });
    await expect(harness.controller.getToken()).rejects.toThrow();
    expect(harness.controller.getSnapshot().userId).toBe("alice");

    harness.tokenReply = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    expect(await harness.controller.getToken()).toBeNull();
    expect(harness.controller.getSnapshot().userId).toBeNull();
    expect(harness.sessions.entries.size).toBe(0);
  });

  it("clears the session and the in-flight sign-in on sign out", async () => {
    const harness = makeHarness();
    await signInWith(harness);

    await harness.controller.signOut();

    expect(harness.controller.getSnapshot().userId).toBeNull();
    expect(await harness.controller.getToken()).toBeNull();
  });

  it("adopts a session another tab removed", async () => {
    const harness = makeHarness();
    await signInWith(harness);

    harness.sessions.entries.clear();
    harness.controller.syncFromStorage();

    expect(harness.controller.getSnapshot().userId).toBeNull();
  });
});
