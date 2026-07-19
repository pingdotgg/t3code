import {
  type BrowserNavigationTarget,
  EnvironmentId,
  type PreviewUrlResolution,
} from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { SshEnvironmentGateway } from "../platform/capabilities.ts";
import { ConnectionProfileStore } from "../connection/profileStore.ts";
import type { ConnectionAttemptError, PreparedConnection } from "../connection/model.ts";

export class EnvironmentPortRoutingError extends Schema.TaggedErrorClass<EnvironmentPortRoutingError>()(
  "EnvironmentPortRoutingError",
  {
    environmentId: EnvironmentId,
    reason: Schema.Literals(["configuration", "unsupported"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface EnvironmentPortRouteRequest {
  readonly connection: PreparedConnection;
  readonly target: BrowserNavigationTarget;
}

type EnvironmentPortTarget = Extract<
  BrowserNavigationTarget,
  { readonly kind: "environment-port" }
>;

const normalizeHostname = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, "");

const parseIpv4Address = (host: string): readonly number[] | null => {
  const parts = normalizeHostname(host).split(".").map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
};

const isLocalLoopbackHost = (host: string): boolean => {
  const normalized = normalizeHostname(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  return parseIpv4Address(normalized)?.[0] === 127;
};

const isPrivateNetworkHost = (host: string): boolean => {
  const normalized = normalizeHostname(host);
  if (isLocalLoopbackHost(normalized) || normalized.endsWith(".local")) return true;
  if (normalized.endsWith(".ts.net")) return true;
  const parts = parseIpv4Address(normalized);
  if (parts) {
    return (
      parts[0] === 10 ||
      (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254)
    );
  }
  const firstIpv6Token = normalized.split(":", 1)[0] ?? "";
  if (!normalized.includes(":") || !/^[\da-f]{1,4}$/u.test(firstIpv6Token)) return false;
  const firstIpv6Hextet = Number.parseInt(firstIpv6Token, 16);
  return (
    Number.isInteger(firstIpv6Hextet) &&
    ((firstIpv6Hextet & 0xfe00) === 0xfc00 || (firstIpv6Hextet & 0xffc0) === 0xfe80)
  );
};

const resolvedHost = (hostname: string): string => {
  const normalized = normalizeHostname(hostname);
  return normalized.includes(":") ? `[${normalized}]` : normalized;
};

const parsePreviewUrl = (rawUrl: string): URL | null => {
  try {
    return new URL(normalizePreviewUrl(rawUrl));
  } catch {
    return null;
  }
};

const resolveOnHost = (input: {
  readonly environmentId: EnvironmentId;
  readonly target: EnvironmentPortTarget;
  readonly hostname: string;
  readonly resolutionKind: PreviewUrlResolution["resolutionKind"];
  readonly requestedUrl?: string;
  readonly sourceUrl?: URL;
}): PreviewUrlResolution => {
  const protocol = input.target.protocol ?? "http";
  const path = input.target.path?.startsWith("/")
    ? input.target.path
    : `/${input.target.path ?? ""}`;
  const host = resolvedHost(input.hostname);
  const resolved = input.sourceUrl
    ? new URL(input.sourceUrl)
    : new URL(path, `${protocol}://${host}:${input.target.port}`);
  if (input.sourceUrl) {
    resolved.hostname = host;
    resolved.port = String(input.target.port);
  }
  return {
    requestedUrl: input.requestedUrl ?? `${protocol}://localhost:${input.target.port}${path}`,
    resolvedUrl: resolved.toString(),
    resolutionKind: input.resolutionKind,
    environmentId: input.environmentId,
  };
};

export class EnvironmentPortRouter extends Context.Service<
  EnvironmentPortRouter,
  {
    readonly acquire: (
      request: EnvironmentPortRouteRequest,
    ) => Effect.Effect<
      PreviewUrlResolution,
      ConnectionAttemptError | EnvironmentPortRoutingError,
      Scope.Scope
    >;
  }
>()("@t3tools/client-runtime/preview/router/EnvironmentPortRouter") {
  static readonly layer = Layer.effect(
    EnvironmentPortRouter,
    Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      const profiles = yield* ConnectionProfileStore;

      const acquireEnvironmentPort = Effect.fn("EnvironmentPortRouter.acquireEnvironmentPort")(
        function* (input: {
          readonly connection: PreparedConnection;
          readonly target: EnvironmentPortTarget;
          readonly requestedUrl?: string;
          readonly sourceUrl?: URL;
        }) {
          const environmentId = input.connection.environmentId;
          if (input.connection.target._tag === "RelayConnectionTarget") {
            return yield* new EnvironmentPortRoutingError({
              environmentId,
              reason: "unsupported",
              detail:
                "This environment port needs the planned authenticated preview gateway; T3 Connect preview forwarding is not supported yet.",
            });
          }

          if (input.connection.target._tag === "SshConnectionTarget") {
            const sshTarget = input.connection.target;
            const profile = yield* profiles.get(sshTarget.connectionId).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      new EnvironmentPortRoutingError({
                        environmentId,
                        reason: "configuration",
                        detail: `SSH connection profile ${sshTarget.connectionId} is unavailable.`,
                      }),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
            );
            if (profile._tag !== "SshConnectionProfile") {
              return yield* new EnvironmentPortRoutingError({
                environmentId,
                reason: "configuration",
                detail: `Connection profile ${sshTarget.connectionId} is not an SSH profile.`,
              });
            }
            const forward = yield* ssh.forwardPort({
              target: profile.target,
              remotePort: input.target.port,
            });
            return resolveOnHost({
              ...input,
              target: { ...input.target, port: forward.localPort },
              requestedUrl:
                input.requestedUrl ??
                `${input.target.protocol ?? "http"}://localhost:${input.target.port}${
                  input.target.path?.startsWith("/")
                    ? input.target.path
                    : `/${input.target.path ?? ""}`
                }`,
              environmentId,
              hostname: "127.0.0.1",
              resolutionKind: "ssh-forward",
            });
          }

          const environmentUrl = yield* Effect.try({
            try: () => new URL(input.connection.httpBaseUrl),
            catch: () =>
              new EnvironmentPortRoutingError({
                environmentId,
                reason: "configuration",
                detail: "The environment connection URL is invalid.",
              }),
          });
          if (!isPrivateNetworkHost(environmentUrl.hostname)) {
            return yield* new EnvironmentPortRoutingError({
              environmentId,
              reason: "unsupported",
              detail:
                "This environment port needs the planned authenticated preview gateway; its server address is not directly private-network reachable.",
            });
          }
          return resolveOnHost({
            ...input,
            environmentId,
            hostname: environmentUrl.hostname,
            resolutionKind: isLocalLoopbackHost(environmentUrl.hostname)
              ? "direct"
              : "direct-private-network",
          });
        },
      );

      const acquire = Effect.fn("EnvironmentPortRouter.acquire")(function* (
        request: EnvironmentPortRouteRequest,
      ) {
        const environmentId = request.connection.environmentId;
        if (request.target.kind === "url") {
          const parsed = parsePreviewUrl(request.target.url);
          if (parsed && isLoopbackHost(parsed.hostname)) {
            const environmentUrl = new URL(request.connection.httpBaseUrl);
            if (
              parsed.hostname === "0.0.0.0" ||
              request.connection.target._tag === "SshConnectionTarget" ||
              !isLocalLoopbackHost(environmentUrl.hostname)
            ) {
              return yield* acquireEnvironmentPort({
                connection: request.connection,
                target: {
                  kind: "environment-port",
                  port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
                  protocol: parsed.protocol === "https:" ? "https" : "http",
                  path: `${parsed.pathname}${parsed.search}${parsed.hash}`,
                },
                requestedUrl: request.target.url,
                sourceUrl: parsed,
              });
            }
          }
          return {
            requestedUrl: request.target.url,
            resolvedUrl: request.target.url,
            resolutionKind: "direct" as const,
            environmentId,
          };
        }
        return yield* acquireEnvironmentPort({
          connection: request.connection,
          target: request.target,
        });
      });

      return EnvironmentPortRouter.of({ acquire });
    }),
  );
}
