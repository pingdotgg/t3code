/**
 * SharedMcpProxy — T3 Code's own client for the user's shared MCP servers.
 *
 * Agents never connect to a shared server themselves: each one reaches it at
 * `<t3-code endpoint>/shared/<key>` with its thread credential, and T3 opens
 * the real connection with the server's saved headers and OAuth tokens, which
 * stay in the secret store. One connection per server is kept and reused by
 * every thread; a sign-in started from Settings completes through the OAuth
 * callback route and is picked up by the next request.
 *
 * @module mcp/SharedMcpProxy
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { SseError, SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { type SharedMcpServer, sharedMcpServerKey } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { sharedMcpOAuthSecretName } from "../serverSettings.ts";

/** Path under T3's MCP endpoint that serves one shared server. */
export const SHARED_MCP_PATH_SEGMENT = "shared";
/** Route the OAuth provider redirects back to after a sign-in. */
export const SHARED_MCP_OAUTH_CALLBACK_PATH = "/api/mcp-oauth/callback";

/** Long enough for slow tools; progress notifications keep extending it. */
const TOOL_CALL_TIMEOUT_MS = 10 * 60_000;
/** A sign-in the user never finishes is dropped after this long. */
const PENDING_SIGN_IN_TTL_MS = 15 * 60_000;

export class SharedMcpProxyError extends Schema.TaggedError<SharedMcpProxyError>()(
  "SharedMcpProxyError",
  {
    server: Schema.String,
    message: Schema.String,
    /** The server needs a sign-in from Settings before it can be used. */
    needsSignIn: Schema.Boolean,
  },
) {}

/** OAuth state kept per server: the registered client, its tokens, and the in-flight PKCE verifier. */
const StoredOAuth = Schema.Struct({
  redirectUrl: Schema.optionalKey(Schema.String),
  clientInformation: Schema.optionalKey(Schema.Unknown),
  tokens: Schema.optionalKey(Schema.Unknown),
  codeVerifier: Schema.optionalKey(Schema.String),
});
type StoredOAuth = typeof StoredOAuth.Type;
const decodeStoredOAuth = Schema.decodeUnknownOption(Schema.fromJsonString(StoredOAuth));
const encodeStoredOAuth = Schema.encodeSync(Schema.fromJsonString(StoredOAuth));

/** The server refused us for want of a login, whether or not an OAuth flow ran. */
const isUnauthorized = (cause: unknown) =>
  cause instanceof UnauthorizedError ||
  ((cause instanceof StreamableHTTPError || cause instanceof SseError) && cause.code === 401);

export class SharedMcpProxy extends Context.Service<
  SharedMcpProxy,
  {
    /** Upstream tool list, as the agent's `tools/list` would see it. */
    readonly listTools: (
      server: SharedMcpServer,
      params: unknown,
    ) => Effect.Effect<unknown, SharedMcpProxyError>;
    /** Forward one tool call; the result is passed back unchanged. */
    readonly callTool: (
      server: SharedMcpServer,
      params: unknown,
    ) => Effect.Effect<unknown, SharedMcpProxyError>;
    /** Connect and count tools, for Settings' Test connection. */
    readonly probe: (
      server: SharedMcpServer,
    ) => Effect.Effect<
      { readonly serverName: string | null; readonly toolCount: number },
      SharedMcpProxyError
    >;
    /**
     * Start an OAuth sign-in, redirecting back to `redirectBaseUrl`. Returns the
     * URL to open, or null when the server needs no sign-in.
     */
    readonly startSignIn: (
      server: SharedMcpServer,
      redirectBaseUrl: string,
    ) => Effect.Effect<{ readonly authorizationUrl: string | null }, SharedMcpProxyError>;
    /** Complete a sign-in from the provider's callback. */
    readonly finishSignIn: (
      state: string,
      code: string,
    ) => Effect.Effect<{ readonly server: string }, SharedMcpProxyError>;
  }
>()("t3/mcp/SharedMcpProxy") {}

/**
 * The SDK's transports declare optional fields without `| undefined`, which
 * this repo's `exactOptionalPropertyTypes` rejects; they are the SDK's own
 * types on both sides, so the cast is sound.
 */
const asTransport = (transport: StreamableHTTPClientTransport | SSEClientTransport) =>
  transport as unknown as Parameters<Client["connect"]>[0];

type Upstream = { readonly fingerprint: string; readonly client: Promise<Client> };
type PendingSignIn = {
  readonly server: SharedMcpServer;
  readonly transport: StreamableHTTPClientTransport;
  readonly expiresAt: number;
};

const make = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(context);
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  const loadOAuth = (key: string) =>
    secretStore.get(sharedMcpOAuthSecretName(key)).pipe(
      Effect.map((secret) =>
        Option.isSome(secret)
          ? Option.getOrElse(
              decodeStoredOAuth(textDecoder.decode(secret.value)),
              (): StoredOAuth => ({}),
            )
          : ({} satisfies StoredOAuth),
      ),
      Effect.orElseSucceed((): StoredOAuth => ({})),
    );
  const saveOAuth = (key: string, stored: StoredOAuth) =>
    secretStore
      .set(sharedMcpOAuthSecretName(key), textEncoder.encode(encodeStoredOAuth(stored)))
      .pipe(Effect.ignore({ log: true }));
  const newState = crypto.randomUUIDv4.pipe(Effect.orDie);

  /**
   * The SDK's view of a server's OAuth state, written through to the secret
   * store. `interactive` providers record the authorization URL for a sign-in;
   * the others leave a missing or expired login as "needs sign-in".
   */
  const makeProvider = (
    key: string,
    initial: StoredOAuth,
    interactive: boolean,
  ): OAuthClientProvider & {
    readonly authorizationUrl: () => URL | undefined;
    readonly lastState: () => string | undefined;
  } => {
    let stored = initial;
    let authorizationUrl: URL | undefined;
    let lastState: string | undefined;
    const update = (patch: Partial<StoredOAuth>) => {
      stored = { ...stored, ...patch };
      return run(saveOAuth(key, stored));
    };
    return {
      get redirectUrl() {
        return stored.redirectUrl;
      },
      get clientMetadata(): OAuthClientMetadata {
        return {
          client_name: "T3 Code",
          redirect_uris: stored.redirectUrl === undefined ? [] : [stored.redirectUrl],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        };
      },
      state: async () => {
        lastState = await run(newState);
        return lastState;
      },
      clientInformation: () => stored.clientInformation as OAuthClientInformationMixed | undefined,
      saveClientInformation: (clientInformation) => update({ clientInformation }),
      tokens: () => stored.tokens as OAuthTokens | undefined,
      saveTokens: (tokens) => update({ tokens }),
      redirectToAuthorization: (url) => {
        if (interactive) authorizationUrl = url;
      },
      saveCodeVerifier: (codeVerifier) => update({ codeVerifier }),
      codeVerifier: () => {
        if (stored.codeVerifier === undefined) throw new Error("No sign-in is in progress.");
        return stored.codeVerifier;
      },
      authorizationUrl: () => authorizationUrl,
      lastState: () => lastState,
    };
  };

  const fail = (server: SharedMcpServer, cause: unknown) =>
    new SharedMcpProxyError({
      server: server.name,
      needsSignIn: isUnauthorized(cause),
      message: isUnauthorized(cause)
        ? `Sign in to ${server.name} in T3 Code (Settings → Integrations → Shared MCP servers).`
        : `Could not reach ${server.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
    });

  const connect = async (server: SharedMcpServer): Promise<Client> => {
    const key = sharedMcpServerKey(server);
    const stored = await run(loadOAuth(key));
    const url = new URL(server.url);
    // Without tokens there is nothing to refresh, and a 401 means "sign in";
    // the SDK would otherwise try a token request with no code.
    const options = () => ({
      requestInit: { headers: { ...server.headers } },
      ...(stored.tokens === undefined ? {} : { authProvider: makeProvider(key, stored, false) }),
    });
    const client = new Client({ name: "T3 Code", version: "1.0.0" });
    try {
      await client.connect(asTransport(new StreamableHTTPClientTransport(url, options())));
      return client;
    } catch (error) {
      // A server that predates streamable HTTP still speaks the SSE transport.
      if (isUnauthorized(error)) throw error;
      const fallback = new Client({ name: "T3 Code", version: "1.0.0" });
      try {
        await fallback.connect(asTransport(new SSEClientTransport(url, options())));
        return fallback;
      } catch {
        throw error;
      }
    }
  };

  const upstreams = new Map<string, Upstream>();
  const fingerprintOf = (server: SharedMcpServer) =>
    `${server.url}\n${Object.entries(server.headers)
      .map(([name, value]) => `${name.toLowerCase()}:${value}`)
      .toSorted()
      .join("\n")}`;
  const clientFor = (server: SharedMcpServer): Promise<Client> => {
    const key = sharedMcpServerKey(server);
    const fingerprint = fingerprintOf(server);
    const existing = upstreams.get(key);
    if (existing !== undefined && existing.fingerprint === fingerprint) return existing.client;
    if (existing !== undefined)
      void existing.client.then((client) => client.close()).catch(() => {});
    const client = connect(server);
    upstreams.set(key, { fingerprint, client });
    // A failed connect is retried on the next request rather than cached.
    client.catch(() => {
      if (upstreams.get(key)?.client === client) upstreams.delete(key);
    });
    return client;
  };
  const dropClient = (key: string) => {
    const existing = upstreams.get(key);
    upstreams.delete(key);
    if (existing !== undefined)
      void existing.client.then((client) => client.close()).catch(() => {});
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const key of upstreams.keys()) dropClient(key);
    }),
  );

  /** Runs `use` on the server's connection, reconnecting once if it went stale. */
  const withClient = <A>(server: SharedMcpServer, use: (client: Client) => Promise<A>) =>
    Effect.tryPromise({
      try: async () => {
        try {
          return await use(await clientFor(server));
        } catch (error) {
          if (isUnauthorized(error)) throw error;
          dropClient(sharedMcpServerKey(server));
          return await use(await clientFor(server));
        }
      },
      catch: (cause) => fail(server, cause),
    });

  const pending = new Map<string, PendingSignIn>();
  const prunePending = (now: number) => {
    for (const [state, entry] of pending) if (entry.expiresAt <= now) pending.delete(state);
  };

  const startSignIn = Effect.fn("SharedMcpProxy.startSignIn")(function* (
    server: SharedMcpServer,
    redirectBaseUrl: string,
  ) {
    const key = sharedMcpServerKey(server);
    const redirectUrl = new URL(SHARED_MCP_OAUTH_CALLBACK_PATH, redirectBaseUrl).toString();
    const stored: StoredOAuth = yield* loadOAuth(key);
    // A client registered for another origin can't receive this redirect.
    const { clientInformation: _client, codeVerifier: _verifier, ...kept } = stored;
    const next: StoredOAuth =
      stored.redirectUrl === redirectUrl ? stored : { ...kept, redirectUrl };
    yield* saveOAuth(key, next);
    const provider = makeProvider(key, next, true);
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { ...server.headers } },
      authProvider: provider,
    });
    const client = new Client({ name: "T3 Code", version: "1.0.0" });
    // An unauthorized connect is the expected path: the provider has just
    // recorded where to send the user.
    const connected = yield* Effect.tryPromise({
      try: () =>
        client.connect(asTransport(transport)).then(
          () => true,
          (cause: unknown) => {
            if (isUnauthorized(cause)) return false;
            throw cause;
          },
        ),
      catch: (cause) => fail(server, cause),
    });
    if (connected) {
      // Already signed in (or no sign-in needed): use this connection.
      dropClient(key);
      upstreams.set(key, { fingerprint: fingerprintOf(server), client: Promise.resolve(client) });
      return { authorizationUrl: null };
    }
    const authorizationUrl = provider.authorizationUrl();
    const state = provider.lastState();
    if (authorizationUrl === undefined || state === undefined) {
      return yield* new SharedMcpProxyError({
        server: server.name,
        needsSignIn: true,
        message: `${server.name} asked for a sign-in T3 Code could not start.`,
      });
    }
    const now = yield* Clock.currentTimeMillis;
    prunePending(now);
    pending.set(state, { server, transport, expiresAt: now + PENDING_SIGN_IN_TTL_MS });
    return { authorizationUrl: authorizationUrl.toString() };
  });

  const finishSignIn = Effect.fn("SharedMcpProxy.finishSignIn")(function* (
    state: string,
    code: string,
  ) {
    const entry = pending.get(state);
    pending.delete(state);
    if (entry === undefined || entry.expiresAt <= (yield* Clock.currentTimeMillis)) {
      return yield* new SharedMcpProxyError({
        server: "",
        needsSignIn: true,
        message: "This sign-in link has expired. Start it again from T3 Code.",
      });
    }
    yield* Effect.tryPromise({
      try: () => entry.transport.finishAuth(code),
      catch: (cause) => fail(entry.server, cause),
    });
    // The next request connects with the new tokens.
    dropClient(sharedMcpServerKey(entry.server));
    return { server: entry.server.name };
  });

  return SharedMcpProxy.of({
    listTools: (server, params) =>
      withClient(server, (client) =>
        client.listTools(params as Parameters<Client["listTools"]>[0]),
      ),
    callTool: (server, params) =>
      withClient(server, (client) =>
        client.callTool(params as Parameters<Client["callTool"]>[0], undefined, {
          timeout: TOOL_CALL_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
        }),
      ),
    probe: (server) =>
      withClient(server, async (client) => ({
        serverName: client.getServerVersion()?.name ?? null,
        toolCount: (await client.listTools()).tools.length,
      })),
    startSignIn,
    finishSignIn,
  });
});

export const layer = Layer.effect(SharedMcpProxy, make);
