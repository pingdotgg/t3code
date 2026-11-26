import {
  type AuthEnvironmentScope,
  type AuthSessionId,
  AuthStandardClientScopes,
  type EnvironmentId,
  EnvironmentHttpApi,
  type PeerLinkClientPairingCredential,
  type PeerLinkClientPairingInput,
  type PeerLinkClientPairingRequest,
  type PeerLinkClientPairingResult,
  PeerLinkError,
  type PeerLinkLinkPairingInput,
  type PeerLinkRevokeSubjectRequest,
  type PeerLinkRevokeSubjectResult,
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
import { isTeamHubOnlyServer } from "../team/hubOnly.ts";
import * as PeerLinks from "./PeerLinks.ts";

/** Long enough for the client to reach the linked environment and redeem it, and no longer. */
const CLIENT_PAIRING_TTL = Duration.minutes(3);
const CLIENT_LABEL_MAX_LENGTH = 80;
export const TEAM_MEMBER_REMOTE_SUBJECT_PREFIX = "team-member:";

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
    readonly revokeSubject: (
      caller: EnvironmentAuth.McpClientSession,
      request: PeerLinkRevokeSubjectRequest,
    ) => Effect.Effect<
      PeerLinkRevokeSubjectResult,
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
        readonly teamMemberSubject?: string;
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
    /**
     * Revokes any direct client sessions and pending pairing links on a linked environment whose
     * subject starts with `subjectPrefix` (must begin with `team-member:`). Reports `ok: false`
     * when the remote environment could not be reached or refused so callers can retain and retry.
     */
    readonly revokeSubject: (
      environmentId: EnvironmentId,
      subjectPrefix: string,
    ) => Effect.Effect<
      | ({ readonly ok: true } & PeerLinkRevokeSubjectResult)
      | { readonly ok: false; readonly reason: string }
    >;
  }
>()("t3/peer/PeerClientPairing") {}

const makeIssuer = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const teamHubOnly = yield* isTeamHubOnlyServer;
  const maxRuntimeMode = serverSettings.managedPolicy?.limits?.maxRuntimeMode;
  const enabled = teamHubOnly
    ? Effect.succeed(true)
    : serverSettings.getSettings.pipe(
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
    if (
      request.subject !== undefined &&
      !request.subject.startsWith(TEAM_MEMBER_REMOTE_SUBJECT_PREFIX)
    ) {
      return yield* new PeerClientPairingRefused({
        reason: "policy",
        message: "Only team-member subjects may be attached to peer-link client pairings.",
      });
    }
    const clientLabel = Array.from(request.clientLabel).slice(0, CLIENT_LABEL_MAX_LENGTH).join("");
    const issued = yield* auth
      .createPairingLink({
        scopes,
        ttl: CLIENT_PAIRING_TTL,
        label: `${clientLabel} · via ${via}`,
        ...(request.subject !== undefined ? { subject: request.subject } : {}),
      })
      .pipe(Effect.catchTags({ ManagedPolicyRefusedError: refusedByPolicy }));
    return { credential: issued.credential, expiresAt: issued.expiresAt };
  });

  const revokeSubject: PeerClientPairingIssuer["Service"]["revokeSubject"] = Effect.fn(
    "PeerClientPairingIssuer.revokeSubject",
  )(function* (caller, request) {
    if (!(yield* enabled)) {
      return yield* new PeerClientPairingRefused({
        reason: "disabled",
        message: PeerLinks.LINKED_ENVIRONMENTS_OFF,
      });
    }
    if (!caller.peerLink || caller.access !== "full-access") {
      return yield* new PeerClientPairingRefused({
        reason: "not_a_full_access_link",
        message: "Only a full-access link may revoke team-minted client sessions here.",
      });
    }
    if (!request.subjectPrefix.startsWith(TEAM_MEMBER_REMOTE_SUBJECT_PREFIX)) {
      return yield* new PeerClientPairingRefused({
        reason: "policy",
        message: "Only team-member subjects may be revoked over a peer link.",
      });
    }
    return yield* auth.revokeGrantsBySubjectPrefix(request.subjectPrefix);
  });

  return PeerClientPairingIssuer.of({ issue, revokeSubject });
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
      (request.link !== undefined && peer.capabilities.linkPairingForLink !== true) ||
      // Older peers ignore `subject` and lack `/revoke-subject`, leaving unrevocable team sessions.
      (request.subject !== undefined && peer.capabilities.linkSubjectScopedClientPairing !== true)
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
    ask(input, client.sessionId, (clientLabel) => ({
      scopes: client.scopes,
      clientLabel,
      ...(client.teamMemberSubject !== undefined ? { subject: client.teamMemberSubject } : {}),
    }));

  const requestForLink: PeerClientPairing["Service"]["requestForLink"] = (input, client) =>
    ask(input, client.sessionId, (clientLabel) => ({
      scopes: [],
      clientLabel,
      link: { access: input.access },
    }));

  const revokeSubject: PeerClientPairing["Service"]["revokeSubject"] = Effect.fn(
    "PeerClientPairing.revokeSubject",
  )(function* (environmentId, subjectPrefix) {
    if (!subjectPrefix.startsWith(TEAM_MEMBER_REMOTE_SUBJECT_PREFIX)) {
      return { ok: false as const, reason: "invalid_subject_prefix" };
    }
    if (!(yield* links.enabled)) {
      return { ok: false as const, reason: "disabled" };
    }
    const stored = yield* links.get(environmentId).pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(stored)) {
      return { ok: false as const, reason: "unknown_link" };
    }
    if (stored.value.access !== "full-access") {
      // Non-full-access links can never mint client pairings (see issue/ask), so there are no
      // team-minted direct sessions to revoke on that peer.
      return { ok: true as const, revokedSessions: 0, revokedPairingLinks: 0 };
    }
    const resolved = yield* links.resolve(environmentId).pipe(Effect.option);
    if (Option.isNone(resolved)) {
      return { ok: false as const, reason: "unreachable" };
    }
    const peer = resolved.value;
    if (peer.capabilities.linkSubjectScopedClientPairing !== true) {
      // Peers without subject-scoped pairing are refused in `request`, so no team-member grants exist.
      return { ok: true as const, revokedSessions: 0, revokedPairingLinks: 0 };
    }
    const api = yield* HttpApiClient.make(ClientPairingApi, { baseUrl: peer.url }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return yield* api.peerLink
      .revokeSubject({
        headers: { authorization: `Bearer ${peer.token}` },
        payload: { subjectPrefix },
      })
      .pipe(
        Effect.timeout(PeerLinks.probeTimeout(peer.url)),
        Effect.map((result) => ({ ok: true as const, ...result })),
        Effect.tapError((cause) =>
          Effect.logWarning("PeerClientPairing.revokeSubject failed", {
            environmentId,
            cause,
          }),
        ),
        Effect.orElseSucceed(() => ({ ok: false as const, reason: "request_failed" })),
      );
  });

  return PeerClientPairing.of({ request, requestForLink, revokeSubject });
});

export const layer = Layer.effect(PeerClientPairing, make);
