import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

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

export class ElectronProtocolRegistrationError extends Data.TaggedError(
  "ElectronProtocolRegistrationError",
)<{
  readonly scheme: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `Failed to register ${this.scheme}: protocol.`;
  }
}

export interface DesktopProtocolRegistrationInput {
  readonly scheme: string;
  readonly targetOrigin: URL;
  readonly backendOrigin: URL;
  readonly clerkFrontendApiHostname: string | undefined;
}

export interface ElectronProtocolShape {
  readonly registerDesktopProtocol: (
    input: DesktopProtocolRegistrationInput,
  ) => Effect.Effect<void, ElectronProtocolRegistrationError, Scope.Scope>;
}

export class ElectronProtocol extends Context.Service<ElectronProtocol, ElectronProtocolShape>()(
  "@t3tools/desktop/electron/ElectronProtocol",
) {}

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
  const connectSources = new Set(["'self'", ...(clerkOrigin ? [clerkOrigin] : [])]);

  const addConnectOrigin = (url: URL) => {
    connectSources.add(url.origin);
    if (url.protocol === "http:" || url.protocol === "https:") {
      const webSocketProtocol = url.protocol === "https:" ? "wss:" : "ws:";
      connectSources.add(`${webSocketProtocol}//${url.host}`);
    }
  };

  addConnectOrigin(input.backendOrigin);
  if (input.scheme === DESKTOP_DEVELOPMENT_SCHEME) {
    addConnectOrigin(input.targetOrigin);
  }

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `connect-src ${[...connectSources].join(" ")}`,
    "img-src 'self' https://img.clerk.com data:",
    "style-src 'self' 'unsafe-inline'",
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
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  const response = await Electron.net.fetch(targetUrl.toString(), init);
  return withContentSecurityPolicy(response, contentSecurityPolicy);
}

const make = Effect.gen(function* () {
  const registered = yield* Ref.make(false);

  const registerDesktopProtocol = Effect.fn("desktop.electron.protocol.registerDesktopProtocol")(
    function* (input: DesktopProtocolRegistrationInput) {
      if (yield* Ref.get(registered)) return;

      const contentSecurityPolicy = makeDesktopContentSecurityPolicy(input);

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            Electron.protocol.handle(input.scheme, (request) =>
              proxyRequest(request, input.targetOrigin, contentSecurityPolicy),
            );
          },
          catch: (cause) => new ElectronProtocolRegistrationError({ scheme: input.scheme, cause }),
        }).pipe(Effect.andThen(Ref.set(registered, true))),
        () =>
          Effect.sync(() => {
            Electron.protocol.unhandle(input.scheme);
          }).pipe(Effect.andThen(Ref.set(registered, false))),
      );
    },
  );

  return ElectronProtocol.of({ registerDesktopProtocol });
});

export const layer = Layer.effect(ElectronProtocol, make);
