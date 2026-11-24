/**
 * The server's own MCP client for plugins. Agents reach a plugin at `<t3 endpoint>/shared/<id>`
 * with their thread credential; its keys and OAuth tokens never leave the secret store.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { SseError, SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Plugin, PluginTool } from "@t3tools/contracts";
import { MCP_APP_EXTENSION_ID, MCP_APP_MIME_TYPE } from "@t3tools/shared/mcpApp";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";

import packageJson from "../../package.json" with { type: "json" };
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { pluginOAuthSecretName } from "./PluginStore.ts";

/** Route the OAuth provider redirects back to after a sign-in. */
export const PLUGIN_OAUTH_CALLBACK_PATH = "/api/mcp-oauth/callback";

/** Long enough for slow tools; progress notifications keep extending it. */
const TOOL_CALL_TIMEOUT_MS = 10 * 60_000;
const PENDING_SIGN_IN_TTL_MS = 15 * 60_000;

export class PluginProxyError extends Schema.TaggedError<PluginProxyError>()("PluginProxyError", {
  plugin: Schema.String,
  message: Schema.String,
  /** The plugin needs a sign-in from Settings before it can be used. */
  needsSignIn: Schema.Boolean,
}) {}

const StoredOAuth = Schema.Struct({
  redirectUrl: Schema.optionalKey(Schema.String),
  clientInformation: Schema.optionalKey(Schema.Unknown),
  tokens: Schema.optionalKey(Schema.Unknown),
  codeVerifier: Schema.optionalKey(Schema.String),
});
type StoredOAuth = typeof StoredOAuth.Type;
const decodeStoredOAuth = Schema.decodeUnknownOption(Schema.fromJsonString(StoredOAuth));
const encodeStoredOAuth = Schema.encodeSync(Schema.fromJsonString(StoredOAuth));

const isUnauthorized = (cause: unknown) =>
  cause instanceof UnauthorizedError ||
  ((cause instanceof StreamableHTTPError || cause instanceof SseError) && cause.code === 401);

const MAX_UPSTREAM_MESSAGE_CHARS = 300;

const NETWORK_PROBLEMS: Record<string, string> = {
  ECONNREFUSED: "nothing answers at its address",
  ECONNRESET: "it closed the connection",
  ENOENT: "its command was not found",
  ENOTFOUND: "its address was not found",
  ETIMEDOUT: "it did not answer in time",
};

const networkProblem = (cause: unknown): string | undefined => {
  if (!(cause instanceof Error)) return undefined;
  const code = "code" in cause && typeof cause.code === "string" ? cause.code : "";
  // `fetch` hides the socket's error behind its own.
  return NETWORK_PROBLEMS[code] ?? networkProblem(cause.cause);
};

/** Every value the user saved for a plugin that its server could echo back. */
const savedSecrets = (plugin: Plugin, stored: StoredOAuth): ReadonlyArray<string> => {
  const { transport } = plugin;
  const tokens = Predicate.isObject(stored.tokens) ? Object.values(stored.tokens) : [];
  const url = transport.type === "http" ? new URL(transport.url) : undefined;
  return [
    ...(transport.type === "http"
      ? Object.values(transport.headers).flatMap((value) => [value, value.replace(/^\S+\s+/, "")])
      : [...transport.args, ...Object.values(transport.env)]),
    ...(url === undefined ? [] : [...url.searchParams.values(), url.username, url.password]),
    ...tokens,
  ].filter((value): value is string => typeof value === "string" && value.length >= 6);
};

/**
 * What went wrong, in words a model and the user may read. Only an MCP error is the server's own
 * text; every other cause is named, since its message can hold a URL, a header or a path.
 */
const upstreamProblem = (cause: unknown, secrets: ReadonlyArray<string>): string => {
  if (cause instanceof McpError) {
    return secrets
      .toSorted((left, right) => right.length - left.length)
      .reduce((text, secret) => text.replaceAll(secret, "[hidden]"), cause.message)
      .replaceAll(/(https?:\/\/)[^\s/@]*@/g, "$1")
      .replaceAll(/(https?:\/\/[^\s?#]*)[?#]\S*/g, "$1")
      .slice(0, MAX_UPSTREAM_MESSAGE_CHARS);
  }
  if (cause instanceof StreamableHTTPError || cause instanceof SseError) {
    if (cause.code !== undefined && cause.code > 0) return `it answered with HTTP ${cause.code}`;
  }
  return networkProblem(cause) ?? "the connection failed";
};

/** The request never reached the server: a dropped session or a dead connection. */
const isStaleConnection = (cause: unknown) =>
  (cause instanceof StreamableHTTPError && (cause.code === 404 || cause.code === 400)) ||
  cause instanceof TypeError ||
  (cause instanceof Error && cause.message === "Not connected");

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

const visibleToModel = (tool: ListedTool) => {
  const ui = Predicate.isObject(tool._meta) ? tool._meta.ui : undefined;
  const visibility = Predicate.isObject(ui) ? ui.visibility : undefined;
  return !Array.isArray(visibility) || visibility.includes("model");
};

export class PluginProxy extends Context.Service<
  PluginProxy,
  {
    /** The tools a model may call: on in Settings, and not reserved for the plugin's own widgets. */
    readonly listTools: (
      plugin: Plugin,
    ) => Effect.Effect<ReadonlyArray<ListedTool>, PluginProxyError>;
    /** Every tool, including those only a widget may call. */
    readonly listAllTools: (
      plugin: Plugin,
    ) => Effect.Effect<ReadonlyArray<ListedTool>, PluginProxyError>;
    /** A model's call: only to what `listTools` lists. */
    readonly callTool: (
      plugin: Plugin,
      input: { readonly name: string; readonly arguments: Record<string, unknown> },
    ) => Effect.Effect<Awaited<ReturnType<Client["callTool"]>>, PluginProxyError>;
    /** A call by the plugin's own app, which may use tools hidden from models. */
    readonly callToolFromApp: (
      plugin: Plugin,
      input: { readonly name: string; readonly arguments: Record<string, unknown> },
    ) => Effect.Effect<Awaited<ReturnType<Client["callTool"]>>, PluginProxyError>;
    readonly readResource: (
      plugin: Plugin,
      uri: string,
    ) => Effect.Effect<Awaited<ReturnType<Client["readResource"]>>, PluginProxyError>;
    readonly describeTools: (
      plugin: Plugin,
    ) => Effect.Effect<ReadonlyArray<PluginTool>, PluginProxyError>;
    /** The URL to send the user to, or null when the plugin needs no sign-in. */
    readonly startSignIn: (
      plugin: Plugin,
      redirectBaseUrl: string,
    ) => Effect.Effect<{ readonly authorizationUrl: string | null }, PluginProxyError>;
    /** Completes a sign-in from the provider's callback. */
    readonly finishSignIn: (
      state: string,
      code: string,
    ) => Effect.Effect<{ readonly plugin: Plugin }, PluginProxyError>;
    /** Closes the connection of a plugin that changed or was removed. */
    readonly disconnect: (pluginId: string) => Effect.Effect<void>;
  }
>()("t3/kompas/PluginProxy") {}

/**
 * The SDK's transports declare optional fields without `| undefined`, which
 * `exactOptionalPropertyTypes` rejects; both sides are the SDK's own types.
 */
const asTransport = (
  transport: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport,
) => transport as unknown as Parameters<Client["connect"]>[0];

// Servers register their widget tools only for clients that announce the extension.
const newClient = () =>
  new Client(
    { name: "Kompas", version: packageJson.version },
    {
      capabilities: {
        extensions: { [MCP_APP_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } },
      } as ConstructorParameters<typeof Client>[1] extends { capabilities?: infer C } | undefined
        ? NonNullable<C>
        : never,
    },
  );

type Upstream = {
  readonly fingerprint: string;
  readonly client: Promise<Client>;
  /** As last listed on this connection. */
  modelTools?: ReadonlySet<string>;
};
type PendingSignIn = {
  readonly plugin: Plugin;
  readonly transport: StreamableHTTPClientTransport;
  readonly expiresAt: number;
};

const fingerprintOf = (plugin: Plugin) => JSON.stringify(plugin.transport);

const make = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(context);
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  const loadOAuth = (id: string) =>
    secretStore.get(pluginOAuthSecretName(id)).pipe(
      Effect.map((secret): StoredOAuth =>
        Option.getOrElse(
          Option.flatMap(secret, (bytes) => decodeStoredOAuth(textDecoder.decode(bytes))),
          () => ({}),
        ),
      ),
      Effect.orElseSucceed((): StoredOAuth => ({})),
    );
  const saveOAuth = (id: string, stored: StoredOAuth) =>
    secretStore
      .set(pluginOAuthSecretName(id), textEncoder.encode(encodeStoredOAuth(stored)))
      .pipe(Effect.ignore({ log: true }));
  const newState = random.uuidV4().pipe(Effect.orDie);

  /** Only an `interactive` provider keeps the URL; the others leave an expired login as "sign in". */
  const makeProvider = (
    id: string,
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
      return run(saveOAuth(id, stored));
    };
    return {
      get redirectUrl() {
        return stored.redirectUrl;
      },
      get clientMetadata(): OAuthClientMetadata {
        return {
          client_name: "Kompas",
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

  const fail = (plugin: Plugin, cause: unknown, stored: StoredOAuth) => {
    const headers = plugin.transport.type === "http" ? plugin.transport.headers : {};
    // A refused token is fixed by editing the header; signing in with OAuth would not replace it.
    const tokenRefused =
      isUnauthorized(cause) &&
      Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
    return new PluginProxyError({
      plugin: plugin.label,
      needsSignIn: isUnauthorized(cause) && !tokenRefused,
      message: tokenRefused
        ? `${plugin.label} refused the saved Authorization header. Update it in Settings → Plugins.`
        : isUnauthorized(cause)
          ? `Sign in to ${plugin.label} in Settings → Plugins.`
          : cause instanceof McpError
            ? `${plugin.label}: ${upstreamProblem(cause, savedSecrets(plugin, stored))}`
            : `Could not reach ${plugin.label}: ${upstreamProblem(cause, [])}.`,
    });
  };

  /** Runs one exchange with a plugin; its failure never repeats what the user saved for it. */
  const attempt = <A>(plugin: Plugin, exchange: () => Promise<A>) =>
    Effect.flatMap(loadOAuth(plugin.id), (stored) =>
      Effect.tryPromise({ try: exchange, catch: (cause) => fail(plugin, cause, stored) }),
    );

  const connect = async (plugin: Plugin): Promise<Client> => {
    const { transport } = plugin;
    if (transport.type === "stdio") {
      const client = newClient();
      await client.connect(
        asTransport(
          new StdioClientTransport({
            command: transport.command,
            args: [...transport.args],
            // Only PATH and the like: a plugin has no business with the server's own environment.
            env: { ...getDefaultEnvironment(), ...transport.env },
            stderr: "ignore",
          }),
        ),
      );
      return client;
    }
    const stored = await run(loadOAuth(plugin.id));
    const url = new URL(transport.url);
    // Without tokens there is nothing to refresh; the SDK would try a token request with no code.
    const options = () => ({
      requestInit: { headers: { ...transport.headers } },
      ...(stored.tokens === undefined
        ? {}
        : { authProvider: makeProvider(plugin.id, stored, false) }),
    });
    const client = newClient();
    try {
      await client.connect(asTransport(new StreamableHTTPClientTransport(url, options())));
      return client;
    } catch (error) {
      // A server that predates streamable HTTP still speaks the SSE transport.
      if (isUnauthorized(error)) throw error;
      const fallback = newClient();
      try {
        await fallback.connect(asTransport(new SSEClientTransport(url, options())));
        return fallback;
      } catch {
        throw error;
      }
    }
  };

  const upstreams = new Map<string, Upstream>();
  const dropClient = (id: string) => {
    const existing = upstreams.get(id);
    upstreams.delete(id);
    if (existing !== undefined) {
      void existing.client.then((client) => client.close()).catch(() => {});
    }
  };
  const clientFor = (plugin: Plugin): Promise<Client> => {
    const fingerprint = fingerprintOf(plugin);
    const existing = upstreams.get(plugin.id);
    if (existing?.fingerprint === fingerprint) return existing.client;
    dropClient(plugin.id);
    const client = connect(plugin);
    upstreams.set(plugin.id, { fingerprint, client });
    const forget = () => {
      if (upstreams.get(plugin.id)?.client === client) upstreams.delete(plugin.id);
    };
    client.then((connected) => {
      connected.onclose = forget;
    }, forget);
    return client;
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const id of upstreams.keys()) dropClient(id);
    }),
  );

  const withClient = <A>(plugin: Plugin, use: (client: Client) => Promise<A>) =>
    attempt(plugin, async () => {
      try {
        return await use(await clientFor(plugin));
      } catch (error) {
        if (!isStaleConnection(error)) throw error;
        dropClient(plugin.id);
        return await use(await clientFor(plugin));
      }
    });

  const listAllTools = Effect.fn("PluginProxy.listAllTools")(function* (plugin: Plugin) {
    const listed = yield* withClient(plugin, async (client) => {
      const tools: Array<ListedTool> = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return tools;
    });
    const upstream = upstreams.get(plugin.id);
    if (upstream !== undefined) {
      upstream.modelTools = new Set(listed.filter(visibleToModel).map(({ name }) => name));
    }
    return listed;
  });

  const listTools = Effect.fn("PluginProxy.listTools")(function* (plugin: Plugin) {
    const disabled = new Set(plugin.disabledTools);
    return (yield* listAllTools(plugin)).filter(
      (tool) => !disabled.has(tool.name) && visibleToModel(tool),
    );
  });

  const describeTools = Effect.fn("PluginProxy.describeTools")(function* (plugin: Plugin) {
    return (yield* listAllTools(plugin)).filter(visibleToModel).map((tool): PluginTool => ({
      name: tool.name,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      ...(tool.description === undefined ? {} : { description: tool.description.slice(0, 300) }),
    }));
  });

  const callToolFromApp = Effect.fn("PluginProxy.callToolFromApp")(function* (
    plugin: Plugin,
    input: { readonly name: string; readonly arguments: Record<string, unknown> },
  ) {
    if (plugin.disabledTools.includes(input.name)) {
      return yield* new PluginProxyError({
        plugin: plugin.label,
        needsSignIn: false,
        message: `${input.name} is turned off in Settings → Plugins.`,
      });
    }
    return yield* withClient(plugin, (client) =>
      client.callTool(input, undefined, {
        timeout: TOOL_CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
      }),
    );
  });

  const callTool = Effect.fn("PluginProxy.callTool")(function* (
    plugin: Plugin,
    input: { readonly name: string; readonly arguments: Record<string, unknown> },
  ) {
    const visible =
      upstreams.get(plugin.id)?.modelTools?.has(input.name) === true ||
      (yield* listAllTools(plugin)).some(
        (tool) => tool.name === input.name && visibleToModel(tool),
      );
    if (!visible) {
      return yield* new PluginProxyError({
        plugin: plugin.label,
        needsSignIn: false,
        message: `${plugin.label} has no tool ${input.name} that a model may call.`,
      });
    }
    return yield* callToolFromApp(plugin, input);
  });

  const readResource = Effect.fn("PluginProxy.readResource")(function* (
    plugin: Plugin,
    uri: string,
  ) {
    return yield* withClient(plugin, (client) => client.readResource({ uri }));
  });

  const pending = new Map<string, PendingSignIn>();

  const startSignIn = Effect.fn("PluginProxy.startSignIn")(function* (
    plugin: Plugin,
    redirectBaseUrl: string,
  ) {
    if (plugin.transport.type !== "http") return { authorizationUrl: null };
    const redirectUrl = new URL(PLUGIN_OAUTH_CALLBACK_PATH, redirectBaseUrl).toString();
    const stored = yield* loadOAuth(plugin.id);
    // A client registered for another origin can't receive this redirect.
    const { clientInformation: _client, codeVerifier: _verifier, ...kept } = stored;
    const next: StoredOAuth =
      stored.redirectUrl === redirectUrl ? stored : { ...kept, redirectUrl };
    yield* saveOAuth(plugin.id, next);
    const provider = makeProvider(plugin.id, next, true);
    const transport = new StreamableHTTPClientTransport(new URL(plugin.transport.url), {
      requestInit: { headers: { ...plugin.transport.headers } },
      authProvider: provider,
    });
    const client = newClient();
    // An unauthorized connect is the expected path: the provider just recorded where to go.
    const connected = yield* attempt(plugin, () =>
      client.connect(asTransport(transport)).then(
        () => true,
        (cause: unknown) => {
          if (isUnauthorized(cause)) return false;
          throw cause;
        },
      ),
    );
    if (connected) {
      dropClient(plugin.id);
      upstreams.set(plugin.id, {
        fingerprint: fingerprintOf(plugin),
        client: Promise.resolve(client),
      });
      return { authorizationUrl: null };
    }
    const authorizationUrl = provider.authorizationUrl();
    const state = provider.lastState();
    if (authorizationUrl === undefined || state === undefined) {
      return yield* new PluginProxyError({
        plugin: plugin.label,
        needsSignIn: true,
        message: `${plugin.label} asked for a sign-in Kompas could not start.`,
      });
    }
    const now = yield* Clock.currentTimeMillis;
    for (const [key, entry] of pending) if (entry.expiresAt <= now) pending.delete(key);
    pending.set(state, { plugin, transport, expiresAt: now + PENDING_SIGN_IN_TTL_MS });
    return { authorizationUrl: authorizationUrl.toString() };
  });

  const finishSignIn = Effect.fn("PluginProxy.finishSignIn")(function* (
    state: string,
    code: string,
  ) {
    const entry = pending.get(state);
    pending.delete(state);
    if (entry === undefined || entry.expiresAt <= (yield* Clock.currentTimeMillis)) {
      return yield* new PluginProxyError({
        plugin: "",
        needsSignIn: true,
        message: "This sign-in link has expired. Start it again from Settings → Plugins.",
      });
    }
    yield* attempt(entry.plugin, () => entry.transport.finishAuth(code));
    // The next request connects with the new tokens.
    dropClient(entry.plugin.id);
    return { plugin: entry.plugin };
  });

  return PluginProxy.of({
    listTools,
    listAllTools,
    callTool,
    callToolFromApp,
    readResource,
    describeTools,
    startSignIn,
    finishSignIn,
    disconnect: Effect.fn("PluginProxy.disconnect")((pluginId) =>
      Effect.sync(() => dropClient(pluginId)),
    ),
  });
});

export const layer = Layer.effect(PluginProxy, make);
