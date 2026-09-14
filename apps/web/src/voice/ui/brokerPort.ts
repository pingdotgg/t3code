/**
 * Production voice broker port: HTTP calls to the environment's Live session
 * broker routes (`apps/server/src/voice/broker.ts`) over the environment's
 * prepared connection, plus the frozen broker-environment selection.
 *
 * The broker environment decision is frozen (T3-CONTRACTS R3 #1): the primary
 * environment when it is connected, voice-capable, and holds
 * `orchestration:operate` (session creation incurs charges); otherwise the
 * first connected capable environment that does. Tool destinations stay
 * independent of this choice.
 */
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import type {
  EnvironmentId,
  VoiceBrokerSessionCloseInput,
  VoiceBrokerSessionCloseResult,
  VoiceBrokerSessionCreated,
  VoiceBrokerSessionRequest,
  VoiceToolError,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { runtime } from "../../lib/runtime";
import type { VoiceLiveBrokerPort } from "../live-client";

// Route paths duplicated from apps/server/src/voice/broker.ts (the web app
// cannot import from the server package; T3 froze the wire shapes).
const SESSIONS_PATH = "/api/voice/sessions";
const CLOSE_PATH = "/api/voice/sessions/close";

// ---------------------------------------------------------------------------
// Broker environment selection (frozen R3 #1)
// ---------------------------------------------------------------------------

/** The catalog slice the selection needs; supplied by the tool host's
    environment catalog (connection registry + capabilities + session scopes). */
export interface VoiceBrokerCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly isPrimary: boolean;
  readonly voiceLiveCapable: boolean;
  readonly scopes: readonly string[];
}

export type VoiceBrokerSelection =
  | { readonly status: "ok"; readonly environmentId: EnvironmentId; readonly label: string }
  | { readonly status: "unavailable"; readonly reason: string };

export function selectVoiceBrokerEnvironment(
  candidates: readonly VoiceBrokerCandidate[],
): VoiceBrokerSelection {
  const eligible = candidates.filter(
    (candidate) =>
      candidate.connected &&
      candidate.voiceLiveCapable &&
      candidate.scopes.includes(AuthOrchestrationOperateScope),
  );
  const primary = eligible.find((candidate) => candidate.isPrimary);
  const chosen = primary ?? eligible[0];
  if (chosen === undefined) {
    const anyCapable = candidates.some((candidate) => candidate.voiceLiveCapable);
    return {
      status: "unavailable",
      reason: anyCapable
        ? "No connected voice environment grants orchestration:operate for this session."
        : "No connected environment advertises voice live support.",
    };
  }
  return { status: "ok", environmentId: chosen.environmentId, label: chosen.label };
}

// ---------------------------------------------------------------------------
// HTTP broker port
// ---------------------------------------------------------------------------

export type VoiceDpopSigner = Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;

/** Status-code to frozen VoiceToolError code mapping, mirroring the broker's
    own failure responses (T3's broker maps upstream failures identically). */
export function brokerStatusToToolError(status: number, body: string): VoiceToolError {
  const detail = body.trim().length > 0 ? body : `HTTP ${status}`;
  if (status === 401) {
    return { code: "auth_invalid", message: `The voice session was rejected: ${detail}` };
  }
  if (status === 403) {
    return {
      code: "insufficient_scope",
      message: `This session lacks the orchestration:operate scope the voice broker requires: ${detail}`,
    };
  }
  if (status === 400 || status === 404) {
    return { code: "invalid_request", message: `The voice broker rejected the request: ${detail}` };
  }
  return {
    code: "environment_unreachable",
    message: `The voice broker request failed: ${detail}`,
  };
}

export interface FetchVoiceBrokerPortInput {
  readonly prepared: PreparedConnection;
  readonly signer: VoiceDpopSigner;
  readonly fetchImpl?: typeof fetch;
}

/** Builds the broker request's authorization for the connection's credential
    kind: primary connections authenticate by cookie (credentialed fetch),
    bearer connections by token header, relay/DPoP connections by an access
    token plus a freshly signed proof bound to this request. */
export async function buildBrokerAuthHeaders(
  prepared: PreparedConnection,
  signer: VoiceDpopSigner,
  method: "POST",
  url: string,
): Promise<{ headers: Record<string, string>; includeCredentials: boolean }> {
  const authorization = prepared.httpAuthorization;
  if (authorization === null) {
    return { headers: {}, includeCredentials: true };
  }
  if (authorization._tag === "Bearer") {
    return {
      headers: { authorization: `Bearer ${authorization.token}` },
      includeCredentials: false,
    };
  }
  if (Option.isNone(signer)) {
    throw {
      code: "auth_invalid",
      message: "No DPoP signer is available to authorize the voice broker request.",
    } satisfies VoiceToolError;
  }
  const proof = await runtime.runPromise(
    signer.value.createProof({ method, url, accessToken: authorization.accessToken }),
  );
  return {
    headers: { authorization: `DPoP ${authorization.accessToken}`, dpop: proof },
    includeCredentials: false,
  };
}

export function createFetchVoiceBrokerPort(input: FetchVoiceBrokerPortInput): VoiceLiveBrokerPort {
  const doFetch = input.fetchImpl ?? fetch;
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const url = environmentEndpointUrl(input.prepared.httpBaseUrl, path);
    const { headers, includeCredentials } = await buildBrokerAuthHeaders(
      input.prepared,
      input.signer,
      "POST",
      url,
    );
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        ...(includeCredentials ? { credentials: "include" as const } : {}),
      });
    } catch (cause) {
      throw {
        code: "environment_unreachable",
        message: `The voice broker could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
      } satisfies VoiceToolError;
    }
    const text = await response.text();
    if (!response.ok) {
      throw brokerStatusToToolError(response.status, text);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw {
        code: "environment_unreachable",
        message: "The voice broker returned a response that was not valid JSON.",
      } satisfies VoiceToolError;
    }
    return parsed;
  };

  return {
    async respond(request) {
      const parsed = (await post("/api/voice/backend", request)) as Record<string, unknown>;
      if (!Array.isArray(parsed.output) || typeof parsed.status !== "string") {
        throw {
          code: "environment_unreachable",
          message: "Invalid command backend response.",
        } satisfies VoiceToolError;
      }
      return { output: parsed.output, status: parsed.status };
    },
    async mintSession(request: VoiceBrokerSessionRequest): Promise<VoiceBrokerSessionCreated> {
      const parsed = (await post(SESSIONS_PATH, request)) as Record<string, unknown>;
      // Tolerant decode: the live upstream response shape is unverified
      // (T1 gate live_access_unavailable); the broker normalizes it to
      // { sessionId, sdp } but accept obvious aliases rather than guessing.
      const sessionId = parsed.sessionId ?? parsed.id;
      const sdp = parsed.sdp ?? (parsed.answer as Record<string, unknown> | undefined)?.sdp;
      if (typeof sessionId !== "string" || typeof sdp !== "string") {
        throw {
          code: "environment_unreachable",
          message: "The voice broker response did not carry a session id and answer SDP.",
        } satisfies VoiceToolError;
      }
      return {
        sessionId: sessionId as VoiceBrokerSessionCreated["sessionId"],
        sdp,
      };
    },

    async closeSession(
      session: VoiceBrokerSessionCloseInput,
    ): Promise<VoiceBrokerSessionCloseResult> {
      const parsed = (await post(CLOSE_PATH, session)) as Record<string, unknown>;
      return { closed: parsed.closed === true };
    },
  };
}

/** Production port factory: resolves the DPoP signer from the web runtime
    (relay connections only; bearer/cookie connections need none). */
export async function createWebVoiceBrokerPort(
  prepared: PreparedConnection,
): Promise<VoiceLiveBrokerPort> {
  const signer = await runtime.runPromise(
    Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
  );
  return createFetchVoiceBrokerPort({ prepared, signer });
}
