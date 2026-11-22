import { type AuthMcpClientAccess, EnvironmentId, type PeerLinkError } from "@t3tools/contracts";
import {
  createOrbitGatewayClient,
  DEFAULT_ORBIT_GATEWAY_URL,
  OrbitGatewayError,
  orbitGatewayPathWithQuery,
  type OrbitGatewayClientOptions,
  type OrbitGatewayTransport,
} from "@t3tools/client-runtime/orbit-gateway/client";
import { readHashParams } from "@t3tools/shared/remote";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PeerLinks from "../peer/PeerLinks.ts";
import { OrbitGateway } from "./OrbitGateway.ts";

/** Why a link failed. Each message says what to do. */
export const OrbitEnvironmentLinkErrorCode = Schema.Literals([
  "node_access_required",
  "session_expired",
  "pairing_pending",
  "pairing_failed",
  "environment_not_found",
  "gateway_unreachable",
  "links_off",
  "target_links_off",
  "link_failed",
]);
export type OrbitEnvironmentLinkErrorCode = typeof OrbitEnvironmentLinkErrorCode.Type;

export class OrbitEnvironmentLinkError extends Schema.TaggedError<OrbitEnvironmentLinkError>()(
  "OrbitEnvironmentLinkError",
  { code: OrbitEnvironmentLinkErrorCode, message: Schema.String },
) {}

export interface OrbitEnvironmentLinkInput {
  /** The environment id the Gateway lists (`conn-environment-list`). */
  readonly environmentId: string;
  readonly access: AuthMcpClientAccess;
  readonly gatewayUrl?: string;
}

export interface OrbitEnvironmentLinked {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly access: AuthMcpClientAccess;
  readonly expiresAt: string;
}

/**
 * Links this environment to a T3 server Orbit knows, without the pairing code
 * leaving this process. As its own Node, the server asks the Gateway for a
 * one-time pairing link, takes the code from it and links with `PeerLinks`.
 * The code and the link never reach the result, an error, a log or storage.
 */
export class OrbitEnvironmentLink extends Context.Service<
  OrbitEnvironmentLink,
  {
    readonly link: (
      input: OrbitEnvironmentLinkInput,
    ) => Effect.Effect<OrbitEnvironmentLinked, OrbitEnvironmentLinkError>;
  }
>()("t3/orbit/OrbitEnvironmentLink") {}

const fail = (code: OrbitEnvironmentLinkErrorCode, message: string) =>
  Effect.fail(new OrbitEnvironmentLinkError({ code, message }));

const isOrbitGatewayError = Schema.is(OrbitGatewayError);

/** A Gateway failure in words an agent can act on. Only codes and our own text, never the Gateway's body. */
function gatewayFailure(error: unknown, environmentId: string): OrbitEnvironmentLinkError {
  if (!isOrbitGatewayError(error)) {
    return new OrbitEnvironmentLinkError({
      code: "gateway_unreachable",
      message: "The Orbit Gateway did not answer. Check this machine's WireGuard link to Orbit.",
    });
  }
  switch (error.code) {
    case "peer.identity_unknown":
    case "node_access.required":
      return new OrbitEnvironmentLinkError({
        code: "node_access_required",
        message: `This machine's Node may not pair with ${environmentId}. Give it Node access to the Node that serves it, then try again.`,
      });
    case "conn.session_expired":
      return new OrbitEnvironmentLinkError({
        code: "session_expired",
        message: `Orbit's session on ${environmentId} expired. That server renews it when it registers again (on its next start); try again after that.`,
      });
    case "operation.timeout":
      return new OrbitEnvironmentLinkError({
        code: "pairing_pending",
        message: `Orbit is still minting the pairing for ${environmentId} (Operation ${String(error.details.operation_id ?? "unknown")}). No second pairing was started. Try again in a minute; that starts a new pairing.`,
      });
    case "gateway.unreachable":
      return new OrbitEnvironmentLinkError({
        code: "gateway_unreachable",
        message: "The Orbit Gateway did not answer. Check this machine's WireGuard link to Orbit.",
      });
    default:
      return new OrbitEnvironmentLinkError({
        code: "pairing_failed",
        message: `Orbit could not pair with ${environmentId} (${error.code}). Check that the server runs and is registered with Orbit, then try again.`,
      });
  }
}

function linkFailure(error: PeerLinkError): OrbitEnvironmentLinkError {
  switch (error.reason) {
    case "peer_disabled":
      return new OrbitEnvironmentLinkError({
        code: "target_links_off",
        message:
          "Linked environments is off on that server. Turn on linkedEnvironmentsEnabled in its settings (Settings → Labs), then try again.",
      });
    case "disabled":
      return new OrbitEnvironmentLinkError({ code: "links_off", message: error.message });
    default:
      // PeerLinks' own text: it names addresses and reasons, never the code.
      return new OrbitEnvironmentLinkError({ code: "link_failed", message: error.message });
  }
}

/** The one-time code in a `…/pair#token=<code>` link. */
function pairingCode(pairingUrl: string): string | null {
  const url = URL.parse(pairingUrl);
  if (url === null) return null;
  const code = readHashParams(url).get("token")?.trim();
  return code ? code : null;
}

/** `OrbitGateway` as the Conn client's transport: paths below `/api/v1/conn`, text bodies. */
export const orbitGatewayTransport =
  (
    request: OrbitGateway["Service"]["request"],
    gatewayUrl: string,
    run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
  ): OrbitGatewayTransport =>
  async (input) => {
    if (input.method !== "GET" && input.method !== "POST") {
      throw new Error(`Unsupported Orbit Gateway method ${input.method}.`);
    }
    const response = await run(
      request({
        gatewayUrl,
        method: input.method,
        path: `/api/v1/conn${orbitGatewayPathWithQuery(input)}`,
        ...(input.body === undefined ? {} : { body: input.body }),
        // curl's own limit already covers the client's admission `timeoutMs`.
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      }),
    );
    return {
      status: response.status,
      body:
        typeof response.body === "string" ? response.body : (JSON.stringify(response.body) ?? ""),
    };
  };

export const makeLink = (deps: {
  readonly transport: (gatewayUrl: string) => OrbitGatewayTransport;
  readonly links: Pick<PeerLinks.PeerLinks["Service"], "enabled" | "link">;
  readonly clientOptions?: OrbitGatewayClientOptions;
}): OrbitEnvironmentLink["Service"]["link"] =>
  Effect.fn("OrbitEnvironmentLink.link")(function* (input) {
    if (!(yield* deps.links.enabled)) {
      return yield* fail("links_off", PeerLinks.LINKED_ENVIRONMENTS_OFF);
    }
    const gatewayUrl = input.gatewayUrl?.trim() || DEFAULT_ORBIT_GATEWAY_URL;
    const client = createOrbitGatewayClient(deps.transport(gatewayUrl), deps.clientOptions);
    const environments = yield* Effect.tryPromise({
      try: () => client.environments(),
      catch: (error) => gatewayFailure(error, input.environmentId),
    });
    const environment = environments.find((found) => found.environmentId === input.environmentId);
    if (environment === undefined) {
      return yield* fail(
        "environment_not_found",
        `Orbit lists no environment ${input.environmentId}. Use an environment_id from conn-environment-list.`,
      );
    }
    if (environment.status === "session_expired") {
      return yield* gatewayFailure(
        new OrbitGatewayError({
          code: "conn.session_expired",
          message: "",
          status: 409,
          details: {},
        }),
        input.environmentId,
      );
    }
    // One pairing per call: `pair` follows the Operation it starts and never starts another.
    const pairing = yield* Effect.tryPromise({
      try: () => client.pair(environment.environmentId),
      catch: (error) => gatewayFailure(error, input.environmentId),
    });
    const code = pairingCode(pairing.pairingUrl);
    if (code === null || pairing.environmentId !== environment.environmentId) {
      return yield* fail(
        "pairing_failed",
        "Orbit returned a pairing link this version cannot use. Update Orbit, then try again.",
      );
    }
    // Only an address that proves to be this environment receives the code.
    const linked = yield* deps.links
      .link({
        url: environment.url,
        pairingCode: code,
        access: input.access,
        expectedEnvironmentId: EnvironmentId.make(environment.environmentId),
        expectedLabel: environment.label,
      })
      .pipe(Effect.mapError(linkFailure));
    return {
      environmentId: linked.environmentId,
      label: linked.label,
      access: linked.access,
      expiresAt: DateTime.formatIso(linked.expiresAt),
    };
  });

const make = Effect.gen(function* () {
  const gateway = yield* OrbitGateway;
  const links = yield* PeerLinks.PeerLinks;
  const services = yield* Effect.context<never>();
  const clock = yield* Clock.Clock;
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseWith(services)(effect);
  return OrbitEnvironmentLink.of({
    link: makeLink({
      links,
      transport: (gatewayUrl) => orbitGatewayTransport(gateway.request, gatewayUrl, run),
      clientOptions: {
        // The server follows the pairing by polling; Reverb notices are for the clients' launch UI.
        realtime: false,
        sleep: (ms) => run(Effect.sleep(ms)),
        now: () => clock.currentTimeMillisUnsafe(),
      },
    }),
  });
});

export const layer = Layer.effect(OrbitEnvironmentLink, make);
