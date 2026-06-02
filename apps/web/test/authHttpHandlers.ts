import {
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthHttpApi,
  EnvironmentId,
  EnvironmentMetadataHttpApi,
  type AuthEnvironmentScope,
  type ExecutionEnvironmentDescriptor,
  type ServerAuthDescriptor,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { http } from "msw";

const BrowserEnvironmentHttpApi = HttpApi.make("browserEnvironment")
  .add(EnvironmentMetadataHttpApi)
  .add(EnvironmentAuthHttpApi);

const TEST_SESSION_EXPIRES_AT = DateTime.makeUnsafe("2026-05-01T12:00:00.000Z");
const TEST_ENVIRONMENT_DESCRIPTOR: ExecutionEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("environment-local"),
  label: "Local environment",
  platform: {
    os: "darwin",
    arch: "arm64",
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};

const unexpectedEndpoint = (endpoint: string) =>
  Effect.die(new Error(`Unexpected browser environment HTTP endpoint: ${endpoint}`));

export function createAuthenticatedSessionHandlers(getAuthDescriptor: () => ServerAuthDescriptor) {
  const authenticatedAuthLayer = Layer.succeed(EnvironmentAuthenticatedAuth, (httpEffect) =>
    httpEffect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("browser-session"),
        subject: "browser-client",
        method: "browser-session-cookie",
        scopes: new Set<AuthEnvironmentScope>(),
        expiresAt: TEST_SESSION_EXPIRES_AT,
      }),
    ),
  );
  const metadataLayer = HttpApiBuilder.group(BrowserEnvironmentHttpApi, "metadata", (handlers) =>
    handlers.handle("descriptor", () => Effect.succeed(TEST_ENVIRONMENT_DESCRIPTOR)),
  );
  const authLayer = HttpApiBuilder.group(BrowserEnvironmentHttpApi, "auth", (handlers) =>
    handlers
      .handle("session", () =>
        Effect.succeed({
          authenticated: true,
          auth: getAuthDescriptor(),
          sessionMethod: "browser-session-cookie",
          expiresAt: TEST_SESSION_EXPIRES_AT,
        }),
      )
      .handle("browserSession", () =>
        Effect.succeed({
          authenticated: true,
          scopes: [
            "orchestration:read",
            "orchestration:operate",
            "terminal:operate",
            "review:write",
            "relay:read",
          ],
          sessionMethod: "browser-session-cookie",
          expiresAt: TEST_SESSION_EXPIRES_AT,
        }),
      )
      .handle("token", () => unexpectedEndpoint("auth.token"))
      .handle("webSocketTicket", () => unexpectedEndpoint("auth.webSocketTicket"))
      .handle("pairingCredential", () => unexpectedEndpoint("auth.pairingCredential"))
      .handle("pairingLinks", () => unexpectedEndpoint("auth.pairingLinks"))
      .handle("revokePairingLink", () => unexpectedEndpoint("auth.revokePairingLink"))
      .handle("clients", () => unexpectedEndpoint("auth.clients"))
      .handle("revokeClient", () => unexpectedEndpoint("auth.revokeClient"))
      .handle("revokeOtherClients", () => unexpectedEndpoint("auth.revokeOtherClients")),
  ).pipe(Layer.provide(authenticatedAuthLayer));
  const { handler } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(BrowserEnvironmentHttpApi).pipe(
      Layer.provide(metadataLayer),
      Layer.provide(authLayer),
      Layer.provide(authenticatedAuthLayer),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );

  return [
    http.all("*/.well-known/t3/environment", ({ request }) => handler(request)),
    http.all("*/api/auth/*", ({ request }) => handler(request)),
  ] as const;
}
