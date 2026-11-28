import {
  type AuthEnvironmentScope,
  type AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentHttpApi,
  type PeerLinkClientPairingCredential,
  type PeerLinkClientPairingInput,
  type PeerLinkClientPairingRequest,
  type PeerLinkClientPairingResult,
  PeerLinkError,
  type PeerLinkLinkPairingInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PeerLinks from "./PeerLinks.ts";

/** Long enough for the client to reach the linked environment and redeem it, and no longer. */
const CLIENT_PAIRING_TTL = Duration.minutes(3);
const CLIENT_LABEL_MAX_LENGTH = 80;

const ClientPairingApi = HttpApi.make(EnvironmentHttpApi.identifier)
  .add(EnvironmentHttpApi.groups.peerLink)
  .annotateMerge(EnvironmentHttpApi.annotations);

/** Why the linked environment will not mint a client pairing for this caller. */
export class PeerClientPairingRefused extends Schema.TaggedError<PeerClientPairingRefused>()(
  "PeerClientPairingRefused",
  {
    reason: Schema.Literals(["disabled", "not_a_full_access_link", "no_scopes", "policy"]),
    message: Schema.String,
  },
) {}

/**
 * The linked side: mints a one-time pairing credential for a client of the environment that
 * links here, when that environment asks over its link.
 */
export class PeerClientPairingIssuer extends Context.Service<
  PeerClientPairingIssuer,
  {
    readonly issue: (
      caller: EnvironmentAuth.McpClientSession,
      request: PeerLinkClientPairingRequest,
    ) => Effect.Effect<
      PeerLinkClientPairingCredential,
      PeerClientPairingRefused | EnvironmentAuth.ServerAuthInternalError
    >;
  }
>()("t3/peer/PeerClientPairing/PeerClientPairingIssuer") {}

/**
 * The linking side: gets a client of this environment a pairing credential for an environment
 * this one links to, so the client can connect there itself.
 */
export class PeerClientPairing extends Context.Service<
  PeerClientPairing,
  {
    readonly request: (
      input: PeerLinkClientPairingInput,
      client: {
        readonly sessionId: AuthSessionId;
        readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
      },
    ) => Effect.Effect<PeerLinkClientPairingResult, PeerLinkError>;
    /**
     * Gets a pairing code from an environment this one links to, for the client to link another
     * environment there with. The client made the request, so it is named beside the code.
     */
    readonly requestForLink: (
      input: PeerLinkLinkPairingInput,
      client: { readonly sessionId: AuthSessionId },
    ) => Effect.Effect<PeerLinkClientPairingResult, PeerLinkError>;
  }
>()("t3/peer/PeerClientPairing") {}

const makeIssuer = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const maxRuntimeMode = serverSettings.managedPolicy?.limits?.maxRuntimeMode;
  const enabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.linkedEnvironmentsEnabled),
    Effect.orElseSucceed(() => false),
  );

  const issue: PeerClientPairingIssuer["Service"]["issue"] = Effect.fn(
    "PeerClientPairingIssuer.issue",
  )(function* (caller, request) {
    if (!(yield* enabled)) {
      return yield* new PeerClientPairingRefused({
        reason: "disabled",
        message: PeerLinks.LINKED_ENVIRONMENTS_OFF,
      });
    }
    // A full-access link's agents already run as this machine's user and could run
    // `t3 auth pairing create` themselves, so minting here adds no power. Any lower link would
    // gain more than it holds, and so would one an administrator's ceiling holds below full access.
    if (
      !caller.peerLink ||
      caller.access !== "full-access" ||
      (maxRuntimeMode !== undefined && maxRuntimeMode !== "full-access")
    ) {
      return yield* new PeerClientPairingRefused({
        reason: "not_a_full_access_link",
        message: "Only a full-access link may pair a client here.",
      });
    }
    const via = caller.label.startsWith(PeerLinks.LINK_CLIENT_NAME_PREFIX)
      ? caller.label.slice(PeerLinks.LINK_CLIENT_NAME_PREFIX.length)
      : caller.label;
    const refusedByPolicy = (error: { readonly message: string }) =>
      Effect.fail(new PeerClientPairingRefused({ reason: "policy", message: error.message }));
    if (request.link !== undefined) {
      // A link pairing code, as this machine's own Sharing & access would mint: the full-access
      // caller could mint it by running the CLI here, so no access level is more than it holds.
      const issued = yield* auth
        .issuePairingCredential({
          access: request.link.access,
          purpose: "peer-link",
          label: `Link · via ${via}`,
        })
        .pipe(Effect.catchTags({ ManagedPolicyRefusedError: refusedByPolicy }));
      return { credential: issued.credential, expiresAt: issued.expiresAt };
    }
    // Never more than the client holds where it asked, nor more than a pairing code grants.
    const scopes = AuthStandardClientScopes.filter((scope) => request.scopes.includes(scope));
    if (scopes.length === 0) {
      return yield* new PeerClientPairingRefused({
        reason: "no_scopes",
        message: "The client holds no access a pairing could carry.",
      });
    }
    const clientLabel = Array.from(request.clientLabel).slice(0, CLIENT_LABEL_MAX_LENGTH).join("");
    const issued = yield* auth
      .createPairingLink({
        scopes,
        ttl: CLIENT_PAIRING_TTL,
        label: `${clientLabel} · via ${via}`,
      })
      .pipe(Effect.catchTags({ ManagedPolicyRefusedError: refusedByPolicy }));
    return { credential: issued.credential, expiresAt: issued.expiresAt };
  });

  return PeerClientPairingIssuer.of({ issue });
});

export const layerIssuer = Layer.effect(PeerClientPairingIssuer, makeIssuer);

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const httpClient = yield* HttpClient.HttpClient;

  /** What this environment's Connections calls the client that asked. */
  const clientLabelOf = (sessionId: AuthSessionId) =>
    auth.listClientSessions(sessionId).pipe(
      Effect.map((sessions) =>
        EnvironmentAuth.clientSessionLabel(
          sessions.find((session) => session.sessionId === sessionId)?.client,
        ),
      ),
      Effect.orElseSucceed(() => "T3 Code client"),
    );

  /** Asks the linked environment for a pairing; `payload` says for whom. */
  const ask = Effect.fn("PeerClientPairing.ask")(function* (
    input: { readonly environmentId: PeerLinkClientPairingInput["environmentId"] },
    sessionId: AuthSessionId,
    payload: (clientLabel: string) => PeerLinkClientPairingRequest,
  ) {
    if (!(yield* links.enabled)) {
      return yield* new PeerLinkError({
        reason: "disabled",
        message: PeerLinks.LINKED_ENVIRONMENTS_OFF,
      });
    }
    const stored = yield* links.get(input.environmentId);
    if (Option.isNone(stored)) {
      return yield* new PeerLinkError({
        reason: "unknown_link",
        message: "This environment is no longer linked to that one.",
      });
    }
    const { environmentId, label, urls, access, expiresAt } = stored.value;
    if (DateTime.isLessThanOrEqualTo(expiresAt, yield* DateTime.now)) {
      return yield* new PeerLinkError({
        reason: "expired",
        message: `The link to ${label} expired. Link it again with a new pairing code from ${label}.`,
      });
    }
    const unsupported = (
      reason: Extract<PeerLinkClientPairingResult, { type: "unsupported" }>["reason"],
      name = label,
    ): PeerLinkClientPairingResult => ({
      type: "unsupported",
      environmentId,
      label: name,
      urls,
      reason,
    });
    // The linked environment refuses this too; asking would only spend a round trip.
    if (access !== "full-access") return unsupported("link_access");
    const resolved = yield* links.resolve(input.environmentId).pipe(Effect.option);
    if (Option.isNone(resolved)) return unsupported("unreachable");
    const peer = resolved.value;
    const request = payload(yield* clientLabelOf(sessionId));
    if (
      peer.capabilities.linkClientPairing !== true ||
      // One from before this would read the request as a client's and pair the client instead.
      (request.link !== undefined && peer.capabilities.linkPairingForLink !== true)
    ) {
      return unsupported("version", peer.link.label);
    }
    const api = yield* HttpApiClient.make(ClientPairingApi, { baseUrl: peer.url }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return yield* api.peerLink
      .clientPairing({
        headers: { authorization: `Bearer ${peer.token}` },
        payload: request,
      })
      .pipe(
        Effect.timeout(PeerLinks.probeTimeout(peer.url)),
        Effect.map((issued): PeerLinkClientPairingResult => ({
          type: "credential",
          environmentId,
          label: peer.link.label,
          urls,
          credential: issued.credential,
          expiresAt: issued.expiresAt,
        })),
        // No cause is logged or returned: a response this version cannot read may hold the credential.
        Effect.catchTags({
          HttpClientError: () => Effect.succeed(unsupported("unreachable", peer.link.label)),
          TimeoutError: () => Effect.succeed(unsupported("unreachable", peer.link.label)),
        }),
        Effect.orElseSucceed(() => unsupported("refused", peer.link.label)),
      );
  });

  const request: PeerClientPairing["Service"]["request"] = (input, client) =>
    ask(input, client.sessionId, (clientLabel) => ({ scopes: client.scopes, clientLabel }));

  const requestForLink: PeerClientPairing["Service"]["requestForLink"] = (input, client) =>
    ask(input, client.sessionId, (clientLabel) => ({
      scopes: [],
      clientLabel,
      link: { access: input.access },
    }));

  return PeerClientPairing.of({ request, requestForLink });
});

export const layer = Layer.effect(PeerClientPairing, make);
