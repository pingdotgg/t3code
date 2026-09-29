import { useCallback, useEffect, useRef, useState } from "react";

import type { DesktopLocalRebuildStaleness, DesktopLocalRebuildState } from "@t3tools/contracts";

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
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
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

  useEffect(() => {
    const checkStaleness = window.desktopBridge?.checkLocalRebuildStaleness;
    if (!enabled || !checkStaleness) return;

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const run = () => {
      // A slow check (offline origin waits out the git timeout) must not pile
      // overlapping invocations onto the interval.
      if (cancelled || inFlightRef.current) return;
      inFlightRef.current = true;
      setChecking(true);
      void checkStaleness()
        .then((next) => {
          if (!cancelled) setStaleness(next);
        })
        .catch(() => {
          if (!cancelled) {
            setStaleness({
              available: true,
              behind: false,
              behindBy: null,
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
          if (!cancelled) setChecking(false);
        });
    };
    run();
    if (intervalMinutes > 0) {
      timer = setInterval(run, intervalMinutes * 60_000);
    }
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [enabled, intervalMinutes]);

  return { staleness, checking };
}

export interface LocalRebuildRequest {
  readonly requestLocalRebuild: (options?: { readonly pullLatest?: boolean }) => void;
  readonly isStartingLocalRebuild: boolean;
}

/** Confirm-then-invoke flow shared by the settings button and the footer icon. */
export function useRequestLocalRebuild(): LocalRebuildRequest {
  const [isStartingLocalRebuild, setIsStartingLocalRebuild] = useState(false);

  const requestLocalRebuild = useCallback(
    (options?: { readonly pullLatest?: boolean }) => {
      const rebuildAndRestart = window.desktopBridge?.rebuildAndRestart;
      if (!rebuildAndRestart || isStartingLocalRebuild) return;
      const pullLatest = options?.pullLatest === true;
      if (
        !window.confirm(
          pullLatest
            ? "Pull the latest changes, build the checkout, install it, and restart T3 Code?"
            : "Build the current checkout, install it, and restart T3 Code?",
        )
      )
        return;

      setIsStartingLocalRebuild(true);
      void rebuildAndRestart(pullLatest ? { pullLatest: true } : undefined)
        .then((result) => {
          if (result.accepted) {
            toastManager.add({
              type: "success",
              title: "Local rebuild started",
              description: "T3 Code will restart after the new build is ready.",
            });
            return;
          }
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start local rebuild",
              description: [result.message, result.logPath ? `Log: ${result.logPath}` : null]
                .filter(Boolean)
                .join(" "),
            }),
          );
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start local rebuild",
              description:
                error instanceof Error ? error.message : "Local rebuild failed to start.",
            }),
          );
        })
        .finally(() => {
          setIsStartingLocalRebuild(false);
        });
    },
    [isStartingLocalRebuild],
  );

  return { requestLocalRebuild, isStartingLocalRebuild };
}
