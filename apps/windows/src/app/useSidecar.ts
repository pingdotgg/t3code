/**
 * Subscribes the renderer to the sidecar supervisor running in the Tauri
 * shell, and performs the bootstrap-token exchange once the server is ready.
 *
 * This is the Windows counterpart of the macOS `LiveBackend.start()` prologue:
 * observe the supervisor's lifecycle, and on `ready` open an authenticated
 * session against the loopback server. Everything past that point is
 * `@t3tools/client-runtime`'s job.
 */

import { useEffect, useState } from "react";

import {
  type LocalEnvironmentSession,
  openLocalEnvironmentSession,
} from "../connection/desktopBootstrap.ts";
import {
  type ConnectionPhase,
  type SidecarEndpoint,
  type SidecarState,
  onSidecarEndpoint,
  onSidecarState,
  phaseForSidecarState,
  sidecarEndpoint,
  sidecarSnapshot,
} from "../platform/ipc.ts";

export interface SidecarStatus {
  readonly state: SidecarState;
  readonly endpoint: SidecarEndpoint | null;
  readonly session: LocalEnvironmentSession | null;
  readonly phase: ConnectionPhase;
}

const INITIAL: SidecarStatus = {
  state: { kind: "idle" },
  endpoint: null,
  session: null,
  phase: { kind: "idle" },
};

export function useSidecar(fetchImpl: typeof fetch = fetch): SidecarStatus {
  const [state, setState] = useState<SidecarState>(INITIAL.state);
  const [endpoint, setEndpoint] = useState<SidecarEndpoint | null>(null);
  const [session, setSession] = useState<LocalEnvironmentSession | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    // Subscribe first, then read the snapshot: the shell emits the current
    // value on subscribe, but the sidecar can also become ready between the
    // two calls, and a missed `ready` would leave the app on "Launching…".
    void onSidecarState((next) => {
      if (!disposed) {
        setState(next);
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    });
    void onSidecarEndpoint((next) => {
      if (!disposed) {
        setEndpoint(next);
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    });

    void sidecarSnapshot().then((snapshot) => {
      if (!disposed) {
        setState((current) => (current.kind === "idle" ? snapshot : current));
      }
    });
    void sidecarEndpoint().then((current) => {
      if (!disposed && current !== null) {
        setEndpoint((existing) => existing ?? current);
      }
    });

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, []);

  // The bootstrap token is minted per sidecar process, so the exchange is keyed
  // on the endpoint identity: a supervisor restart hands out a new token and
  // must re-run it. Re-running for the same endpoint would be wasted work — the
  // server issues one token per launch.
  useEffect(() => {
    if (endpoint === null || state.kind !== "ready") {
      return;
    }
    let disposed = false;
    setFailure(null);
    void openLocalEnvironmentSession(fetchImpl, endpoint)
      .then((next) => {
        if (!disposed) {
          setSession(next);
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setSession(null);
          setFailure(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      disposed = true;
    };
  }, [endpoint, state.kind, fetchImpl]);

  return {
    state,
    endpoint,
    session,
    phase: resolvePhase(state, session, failure),
  };
}

function resolvePhase(
  state: SidecarState,
  session: LocalEnvironmentSession | null,
  failure: string | null,
): ConnectionPhase {
  if (failure !== null) {
    return { kind: "failed", detail: failure };
  }
  if (state.kind === "ready" && session !== null) {
    return { kind: "ready" };
  }
  return phaseForSidecarState(state);
}
