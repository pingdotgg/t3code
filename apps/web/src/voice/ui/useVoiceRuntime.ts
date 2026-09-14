/**
 * Web wiring for the voice panel: reactive broker-environment eligibility
 * (frozen R3 selection), catalog-backed reachability for the navigator, the
 * TanStack route driver, and the browser mic capture.
 *
 * Everything here reads only existing client state (connection registry,
 * session scopes, delivered server config); credentials stay in T3's
 * existing handling.
 */
import { useRouter, useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { environmentSession, readPreparedConnection } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import type { VoiceLiveBrokerPort } from "../live-client";
import {
  createWebVoiceBrokerPort,
  selectVoiceBrokerEnvironment,
  type VoiceBrokerCandidate,
  type VoiceBrokerSelection,
} from "./brokerPort";
import type { VoiceEnvironmentReachability, VoiceRouteDriver } from "../navigation";
import type { VoiceMicController } from "./voicePanelController";

/** Catalog candidates for the frozen broker-environment selection, derived
    reactively so the entry point appears/disappears with connectivity and
    granted scopes. */
const voiceBrokerCandidatesAtom = Atom.make<readonly VoiceBrokerCandidate[]>((get) => {
  const primaryId = get(primaryEnvironmentIdAtom);
  return [...get(environmentCatalog.catalogValueAtom).entries.entries()].map(
    ([environmentId, entry]) => {
      const supervisor = Option.getOrElse(
        AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
        () => AVAILABLE_CONNECTION_STATE,
      );
      const sessionState = get(environmentSession.sessionStateValueAtom(environmentId));
      const config = get(serverEnvironment.configValueAtom(environmentId));
      return {
        environmentId,
        label: entry.target.label,
        connected: supervisor.phase === "connected",
        isPrimary: environmentId === primaryId,
        voiceLiveCapable: config?.environment.capabilities.voiceLive === true,
        scopes: sessionState?.scopes ?? [],
      };
    },
  );
}).pipe(Atom.withLabel("voice:broker-candidates"));

export const voiceBrokerSelectionAtom = Atom.make<VoiceBrokerSelection>((get) =>
  selectVoiceBrokerEnvironment(get(voiceBrokerCandidatesAtom)),
).pipe(Atom.withLabel("voice:broker-selection"));

/** Synchronous read of the current broker selection (used at connect time,
    not just render time). */
export function readVoiceBrokerSelection(): VoiceBrokerSelection {
  return appAtomRegistry.get(voiceBrokerSelectionAtom);
}

/** Navigator reachability from the live catalog: "unknown" = environment not
    paired in this client, "disconnected" = paired but not connected. */
export function environmentReachability(
  environmentId: EnvironmentId,
): VoiceEnvironmentReachability {
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  if (!catalog.entries.has(environmentId)) {
    return "unknown";
  }
  const supervisor = Option.getOrElse(
    AsyncResult.value(appAtomRegistry.get(environmentCatalog.stateAtom(environmentId))),
    () => AVAILABLE_CONNECTION_STATE,
  );
  return supervisor.phase === "connected" ? "connected" : "disconnected";
}

/** Resolves the production broker port for the current selection: the
    selected environment's prepared connection plus its broker HTTP routes. */
export async function resolveWebVoiceBrokerPort(): Promise<VoiceLiveBrokerPort> {
  const selection = readVoiceBrokerSelection();
  if (selection.status !== "ok") {
    throw {
      code: "environment_unreachable",
      message: selection.reason,
    };
  }
  const prepared: PreparedConnection | null = readPreparedConnection(selection.environmentId);
  if (prepared === null) {
    throw {
      code: "environment_unreachable",
      message: `Environment "${selection.label}" is not connected.`,
    };
  }
  return createWebVoiceBrokerPort(prepared);
}

/** The TanStack route driver: programmatic navigation through the existing
    router APIs, path read-back from live router state, and an onResolved
    subscription for the navigator's late-redirect watch. */
export function useVoiceRouteDriver(): VoiceRouteDriver {
  const navigate = useNavigate();
  const router = useRouter();
  return useMemo(
    () => ({
      navigate: async ({ params, replace }) => {
        await navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: params.environmentId, threadId: params.threadId },
          replace: replace ?? true,
        });
      },
      readCurrentPath: () => router.state.location.pathname,
      subscribePathChange: (listener) => {
        const unsubscribe = router.subscribe("onResolved", () => {
          listener(router.state.location.pathname);
        });
        return unsubscribe;
      },
    }),
    [navigate, router],
  );
}

/** Captures the browser microphone for the live session. Muting toggles the
    track's enabled flag, so the transport keeps flowing while Live hears
    silence. */
export async function captureWebMic(): Promise<VoiceMicController> {
  const mediaDevices = navigator.mediaDevices;
  if (mediaDevices === undefined) {
    throw {
      code: "invalid_request",
      message: "This browser does not expose microphone capture (mediaDevices).",
    };
  }
  let stream: MediaStream;
  try {
    stream = await mediaDevices.getUserMedia({ audio: true });
  } catch (cause) {
    throw {
      code: "invalid_request",
      message: `Microphone access failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const track = stream.getAudioTracks()[0];
  if (track === undefined) {
    for (const candidate of stream.getAudioTracks()) {
      candidate.stop();
    }
    throw {
      code: "invalid_request",
      message: "No microphone track was available from this browser.",
    };
  }
  return {
    track: track as unknown as VoiceMicController["track"],
    setMuted: (muted) => {
      track.enabled = !muted;
    },
    stop: () => {
      track.stop();
    },
  };
}
