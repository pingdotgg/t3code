import { useCallback, useEffect, useRef, useState } from "react";

import type {
  DesktopLocalRebuildLifecycle,
  DesktopLocalRebuildStaleness,
  DesktopLocalRebuildState,
} from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";

/** Local rebuild state from the desktop shell; null outside packaged Dev builds. */
export function useLocalRebuildState(): DesktopLocalRebuildState | null {
  const [state, setState] = useState<DesktopLocalRebuildState | null>(null);

  useEffect(() => {
    const getLocalRebuildState = window.desktopBridge?.getLocalRebuildState;
    if (!getLocalRebuildState) return;

    let cancelled = false;
    void getLocalRebuildState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not read local rebuild availability",
            description:
              error instanceof Error ? error.message : "Desktop rebuild status is unavailable.",
          }),
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

export function useLocalRebuildLifecycle(): DesktopLocalRebuildLifecycle | null {
  const [lifecycle, setLifecycle] = useState<DesktopLocalRebuildLifecycle | null>(null);

  useEffect(() => {
    const bridge = window.desktopBridge;
    const getLifecycle = bridge?.getLocalRebuildLifecycle;
    const subscribe = bridge?.onLocalRebuildLifecycleChanged;
    if (!getLifecycle || !subscribe) return;

    let active = true;
    const accept = (next: DesktopLocalRebuildLifecycle): void => {
      if (!active) return;
      setLifecycle((current) =>
        current === null || next.revision >= current.revision ? next : current,
      );
    };
    const unsubscribe = subscribe(accept);
    void getLifecycle()
      .then(accept)
      .catch((error: unknown) => {
        if (!active) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not read local rebuild status",
            description:
              error instanceof Error ? error.message : "Desktop rebuild status is unavailable.",
          }),
        );
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return lifecycle;
}

export interface LocalRebuildStalenessPoll {
  readonly staleness: DesktopLocalRebuildStaleness | null;
  readonly checking: boolean;
}

/**
 * Poll whether the remote default branch moved past the running Dev build.
 * Checks immediately, then every `intervalMinutes` (0 disables the timer but
 * keeps the initial check). Skipped entirely when `enabled` is false.
 */
export function useLocalRebuildStaleness(input: {
  readonly enabled: boolean;
  readonly intervalMinutes: number;
}): LocalRebuildStalenessPoll {
  const { enabled, intervalMinutes } = input;
  const [staleness, setStaleness] = useState<DesktopLocalRebuildStaleness | null>(null);
  const [checking, setChecking] = useState(false);
  const inFlightRef = useRef(false);
  const generationRef = useRef(0);
  const runRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const checkStaleness = window.desktopBridge?.checkLocalRebuildStaleness;
    if (!enabled || !checkStaleness) {
      runRef.current = null;
      setChecking(false);
      return;
    }

    const generation = ++generationRef.current;
    const run = (): void => {
      if (generation !== generationRef.current) return;
      if (inFlightRef.current) {
        setChecking(true);
        return;
      }
      inFlightRef.current = true;
      setChecking(true);
      let request: Promise<void>;
      request = Promise.resolve()
        .then(checkStaleness)
        .then((next) => {
          if (generation === generationRef.current) setStaleness(next);
        })
        .catch(() => {
          if (generation === generationRef.current) {
            setStaleness({
              available: true,
              behind: false,
              behindBy: null,
              readyToPull: false,
              readinessReason: null,
              localBranch: null,
              localSha: null,
              remoteBranch: null,
              remoteSha: null,
              buildSha: null,
              checkedAt: new Date().toISOString(),
              error: "The staleness check failed to run.",
            });
          }
        })
        .finally(() => {
          inFlightRef.current = false;
          if (generation === generationRef.current) {
            setChecking(false);
          } else if (runRef.current) {
            queueMicrotask(() => runRef.current?.());
          }
        });
      void request;
    };
    runRef.current = run;
    run();
    return () => {
      if (generation === generationRef.current) {
        generationRef.current += 1;
        runRef.current = null;
        setChecking(false);
      }
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || intervalMinutes <= 0) return;
    const timer = setInterval(() => runRef.current?.(), intervalMinutes * 60_000);
    return () => clearInterval(timer);
  }, [enabled, intervalMinutes]);

  return { staleness, checking };
}

export interface LocalRebuildRequest {
  readonly requestLocalRebuild: (options?: { readonly pullLatest?: boolean }) => void;
  readonly isStartingLocalRebuild: boolean;
  readonly lifecycle: DesktopLocalRebuildLifecycle | null;
}

/** Confirm-then-invoke flow shared by the settings button and the footer icon. */
export function useRequestLocalRebuild(): LocalRebuildRequest {
  const lifecycle = useLocalRebuildLifecycle();
  const [requestPending, setRequestPending] = useState(false);
  const requestPendingRef = useRef(false);
  const isStartingLocalRebuild = requestPending || lifecycle?.phase === "running";

  useEffect(() => {
    if (lifecycle?.phase !== "running" || !requestPendingRef.current) return;
    requestPendingRef.current = false;
    setRequestPending(false);
  }, [lifecycle?.phase, lifecycle?.revision]);

  const requestLocalRebuild = useCallback(
    (options?: { readonly pullLatest?: boolean }) => {
      const rebuildAndRestart = window.desktopBridge?.rebuildAndRestart;
      if (!rebuildAndRestart || requestPendingRef.current || isStartingLocalRebuild) return;
      const pullLatest = options?.pullLatest === true;
      if (
        !window.confirm(
          pullLatest
            ? "Pull the latest changes, build the checkout, install it, and restart T3 Code?"
            : "Build the current checkout, install it, and restart T3 Code?",
        )
      )
        return;

      requestPendingRef.current = true;
      setRequestPending(true);
      const releaseRequest = (): void => {
        requestPendingRef.current = false;
        setRequestPending(false);
      };
      const reportFailure = (description: string): void => {
        releaseRequest();
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start local rebuild",
            description,
          }),
        );
      };

      try {
        void rebuildAndRestart(pullLatest ? { pullLatest: true } : undefined)
          .then((result) => {
            if (result.accepted) return;
            reportFailure(
              [result.message, result.logPath ? `Log: ${result.logPath}` : null]
                .filter(Boolean)
                .join(" "),
            );
          })
          .catch((error: unknown) => {
            reportFailure(
              error instanceof Error ? error.message : "Local rebuild failed to start.",
            );
          });
      } catch (error: unknown) {
        reportFailure(error instanceof Error ? error.message : "Local rebuild failed to start.");
      }
    },
    [isStartingLocalRebuild],
  );

  return { requestLocalRebuild, isStartingLocalRebuild, lifecycle };
}
