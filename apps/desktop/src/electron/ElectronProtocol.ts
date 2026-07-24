// @effect-diagnostics nodeBuiltinImport:off - Electron static protocol handlers require synchronous platform path validation.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeTimersPromises from "node:timers/promises";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Electron from "electron";

export const DESKTOP_HOST = "app";
export const DESKTOP_PRODUCTION_SCHEME = "t3code";
export const DESKTOP_DEVELOPMENT_SCHEME = "t3code-dev";

export function getDesktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? DESKTOP_DEVELOPMENT_SCHEME : DESKTOP_PRODUCTION_SCHEME;
}

export function getDesktopOrigin(isDevelopment: boolean): string {
  return `${getDesktopScheme(isDevelopment)}://${DESKTOP_HOST}`;
}

export function getDesktopUrl(isDevelopment: boolean): string {
  return `${getDesktopOrigin(isDevelopment)}/`;
}

export class ElectronProtocolRegistrationError extends Schema.TaggedErrorClass<ElectronProtocolRegistrationError>()(
  "ElectronProtocolRegistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to register Electron protocol scheme "${this.scheme}".`;
  }
}

export class ElectronProtocolUnregistrationError extends Schema.TaggedErrorClass<ElectronProtocolUnregistrationError>()(
  "ElectronProtocolUnregistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to unregister Electron protocol scheme "${this.scheme}".`;
  }
}

interface DesktopProtocolRegistrationBase {
  readonly scheme: string;
  readonly clerkFrontendApiHostname: string | undefined;
}

export type DesktopProtocolRegistrationInput = DesktopProtocolRegistrationBase &
  (
    | {
        readonly source: "proxy";
        readonly targetOrigin: URL;
      }
    | {
        readonly source: "static";
        readonly staticRoot: string;
      }
  );

export class ElectronProtocol extends Context.Service<
  ElectronProtocol,
  {
    readonly registerDesktopProtocol: (
      input: DesktopProtocolRegistrationInput,
    ) => Effect.Effect<void, ElectronProtocolRegistrationError, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronProtocol") {}

export function makeDesktopContentSecurityPolicy(input: DesktopProtocolRegistrationInput): string {
  const clerkOrigin = input.clerkFrontendApiHostname
    ? `https://${input.clerkFrontendApiHostname}`
    : undefined;
  const scriptSources = [
    "'self'",
    "'unsafe-inline'",
    ...(clerkOrigin ? [clerkOrigin] : []),
    "https://challenges.cloudflare.com",
  ];

  // The renderer connects directly to user-configured environments in addition to
  // the build-configured Clerk, relay, and OTLP endpoints. Those environment
  // origins are not known when this response policy is created, so restrict
  // connections by the network schemes the client supports instead of by host.
  const connectSources = ["'self'", "http:", "https:", "ws:", "wss:"];

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `connect-src ${connectSources.join(" ")}`,
    `img-src 'self' ${input.scheme}: blob: data: http: https:`,
    "style-src 'self' 'unsafe-inline'",
    `font-src 'self' ${input.scheme}: data:`,
    "worker-src 'self' blob:",
    "frame-src 'self' https://challenges.cloudflare.com",
    "form-action 'self'",
  ].join("; ");
}

function withContentSecurityPolicy(response: Response, policy: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

type StaticPathResolution =
  | { readonly _tag: "Invalid"; readonly status: 400 | 403 }
  | { readonly _tag: "Resolved"; readonly path: string; readonly relativePath: string };

export function resolveDesktopStaticPath(
  staticRoot: string,
  encodedPathname: string,
): StaticPathResolution {
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(encodedPathname);
  } catch {
    return { _tag: "Invalid", status: 400 };
  }

  if (
    decodedPathname.includes("\0") ||
    decodedPathname.includes("\\") ||
    /^[a-zA-Z]:/u.test(decodedPathname.replace(/^\/+/u, ""))
  ) {
    return { _tag: "Invalid", status: 403 };
  }

  const segments = decodedPathname.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { _tag: "Invalid", status: 403 };
  }

  const relativePath = segments.length === 0 ? "index.html" : segments.join("/");
  const normalizedRoot = NodePath.resolve(staticRoot);
  const resolvedPath = NodePath.resolve(normalizedRoot, relativePath);
  const relativeToRoot = NodePath.relative(normalizedRoot, resolvedPath);
  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relativeToRoot)
  ) {
    return { _tag: "Invalid", status: 403 };
  }

  return {
    _tag: "Resolved",
    path: resolvedPath,
    relativePath,
  };
}

function shouldUseSpaFallback(request: Request, relativePath: string): boolean {
  if (NodePath.extname(relativePath) !== "") {
    return false;
  }
  const accept = request.headers.get("accept") ?? "";
  const mode = request.headers.get("sec-fetch-mode") ?? "";
  return mode === "navigate" || accept.includes("text/html");
}

async function fetchStaticFile(path: string): Promise<Response> {
  try {
    return await Electron.net.fetch(NodeURL.pathToFileURL(path).href, { method: "GET" });
  } catch {
    return new Response(null, { status: 404 });
  }
}

function withStaticResponseHeaders(response: Response, path: string, headOnly: boolean): Response {
  const headers = new Headers(response.headers);
  const contentType = STATIC_CONTENT_TYPES[NodePath.extname(path).toLowerCase()];
  if (contentType !== undefined) {
    headers.set("Content-Type", contentType);
  }
  return new Response(headOnly ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function serveDesktopStaticRequest(
  request: Request,
  staticRoot: string,
  contentSecurityPolicy: string,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.host !== DESKTOP_HOST) {
    return withContentSecurityPolicy(new Response(null, { status: 404 }), contentSecurityPolicy);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return withContentSecurityPolicy(
      new Response(null, {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      }),
      contentSecurityPolicy,
    );
  }

  const resolution = resolveDesktopStaticPath(staticRoot, requestUrl.pathname);
  if (resolution._tag === "Invalid") {
    return withContentSecurityPolicy(
      new Response(null, { status: resolution.status }),
      contentSecurityPolicy,
    );
  }

  let response = await fetchStaticFile(resolution.path);
  let responsePath = resolution.path;
  if (response.status === 404 && shouldUseSpaFallback(request, resolution.relativePath)) {
    responsePath = NodePath.join(staticRoot, "index.html");
    response = await fetchStaticFile(responsePath);
  }

  return withContentSecurityPolicy(
    withStaticResponseHeaders(response, responsePath, request.method === "HEAD"),
    contentSecurityPolicy,
  );
}

async function proxyRequest(
  request: Request,
  targetOrigin: URL,
  contentSecurityPolicy: string,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.host !== DESKTOP_HOST) {
    return new Response(null, { status: 404 });
  }

  const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, targetOrigin);
  const headers = new Headers(request.headers);
  const headersToRemove: string[] = [];
  for (const name of headers.keys()) {
    if (
      name === "host" ||
      name === "origin" ||
      name === "referer" ||
      name === "connection" ||
      name === "content-length" ||
      name === "accept-encoding" ||
      name === "upgrade-insecure-requests" ||
      name.startsWith("sec-fetch-")
    ) {
      headersToRemove.push(name);
    }
  }
  for (const name of headersToRemove) {
    headers.delete(name);
  }
  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  const response =
    request.method === "GET" || request.method === "HEAD"
      ? await fetchWithTransientRetry(targetUrl.toString(), init)
      : await Electron.net.fetch(targetUrl.toString(), init);
  return withContentSecurityPolicy(response, contentSecurityPolicy);
}

const TRANSIENT_FETCH_RETRY_DELAYS_MS = [0, 50, 150] as const;

async function fetchWithTransientRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;

  for (const delayMs of TRANSIENT_FETCH_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await NodeTimersPromises.setTimeout(delayMs);
    }

    try {
      return await Electron.net.fetch(url, init);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export const make = Effect.gen(function* () {
  const registered = yield* Ref.make(false);

  const registerDesktopProtocol = Effect.fn("desktop.electron.protocol.registerDesktopProtocol")(
    function* (input: DesktopProtocolRegistrationInput) {
      if (yield* Ref.get(registered)) return;

      const contentSecurityPolicy = makeDesktopContentSecurityPolicy(input);

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            Electron.protocol.handle(input.scheme, (request) => {
              if (input.source === "static") {
                return serveDesktopStaticRequest(request, input.staticRoot, contentSecurityPolicy);
              }
              return proxyRequest(request, input.targetOrigin, contentSecurityPolicy);
            });
          },
          catch: (cause) => new ElectronProtocolRegistrationError({ scheme: input.scheme, cause }),
        }).pipe(Effect.andThen(Ref.set(registered, true))),
        () =>
          Effect.try({
            try: () => Electron.protocol.unhandle(input.scheme),
            catch: (cause) =>
              new ElectronProtocolUnregistrationError({
                scheme: input.scheme,
                cause,
              }),
          }).pipe(Effect.andThen(Ref.set(registered, false)), Effect.orDie),
      );
    },
  );

  return ElectronProtocol.of({ registerDesktopProtocol });
});

export const layer = Layer.effect(ElectronProtocol, make);
