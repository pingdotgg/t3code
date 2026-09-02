import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useRef } from "react";

import type { SidebarThreadPartition } from "../components/Sidebar.logic";
import { resolveSnoozePresets, snoozeWakeDescription } from "../components/Sidebar.snooze";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useClientSettings } from "../hooks/useSettings";
import { useThreadActions } from "../hooks/useThreadActions";
import { readThreadShell } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { showShellContextMenu } from "./shellContextMenu";

interface ShellThreadRowActionsInput {
  readonly partition: SidebarThreadPartition;
  readonly activeThreadKey: string | null;
}

function keyOf(thread: EnvironmentThreadShell): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * The hover / keyboard actions on a native sidebar row — settle, un-settle,
 * snooze, wake, dismiss the woke pill — with the HTML sidebar's semantics:
 * parking the open thread moves you to the next remaining card (or a fresh
 * draft in the same project), failures toast, and a snooze offers Undo.
 */
export function useShellThreadRowActions(input: ShellThreadRowActionsInput) {
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();
  const { settleThread, unsettleThread, snoozeThread, unsnoozeThread } = useThreadActions();
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  // Read at call time, not at render time: a plan snapshots the list the
  // user was looking at, and the post-await check sees the current route.
  const inputRef = useRef(input);
  inputRef.current = input;
  const timestampFormatRef = useRef(timestampFormat);
  timestampFormatRef.current = timestampFormat;
  const parkingKeysRef = useRef(new Set<string>());

  const navigateToKey = useCallback(
    (key: string) => {
      const threadRef = parseScopedThreadKey(key);
      if (threadRef === null) return;
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [router],
  );

  const planForwardNavigation = useCallback(
    (threadKey: string): (() => void) | null => {
      const { partition, activeThreadKey } = inputRef.current;
      if (activeThreadKey !== threadKey) return null;
      const orderedKeys = [
        ...partition.pinnedThreads,
        ...partition.activeThreads,
        ...partition.snoozedThreads,
        ...partition.settledThreads,
      ].map(keyOf);
      const parked = new Set([...partition.snoozedThreads, ...partition.settledThreads].map(keyOf));
      const currentIndex = orderedKeys.indexOf(threadKey);
      const nextKey =
        currentIndex === -1
          ? null
          : ([...orderedKeys.slice(currentIndex + 1), ...orderedKeys.slice(0, currentIndex)].find(
              (key) => !parked.has(key),
            ) ?? null);
      if (nextKey !== null) return () => navigateToKey(nextKey);
      const threadRef = parseScopedThreadKey(threadKey);
      const shell = threadRef ? readThreadShell(threadRef) : undefined;
      return shell
        ? () => void handleNewThread(scopeProjectRef(shell.environmentId, shell.projectId))
        : () => void router.navigate({ to: "/" });
    },
    [handleNewThread, navigateToKey, router],
  );

  /** Runs one parking mutation with the forward-navigation plan around it. */
  const park = useCallback(
    async (
      threadKey: string,
      failureTitle: string,
      run: () => Promise<AtomCommandResult<unknown, unknown>>,
    ): Promise<boolean> => {
      if (parkingKeysRef.current.has(threadKey)) return false;
      parkingKeysRef.current.add(threadKey);
      try {
        const navigateAfter = planForwardNavigation(threadKey);
        const result = await run();
        if (result._tag === "Failure") {
          // Never navigate away from a thread that did not park.
          if (!isAtomCommandInterrupted(result)) {
            failureToast(failureTitle, squashAtomCommandFailure(result));
          }
          return false;
        }
        // A navigation made during the await wins over ours.
        if (inputRef.current.activeThreadKey === threadKey) navigateAfter?.();
        return true;
      } finally {
        parkingKeysRef.current.delete(threadKey);
      }
    },
    [planForwardNavigation],
  );

  const settle = useCallback(
    (key: string) => {
      const threadRef = parseScopedThreadKey(key);
      if (threadRef === null) return;
      void park(key, "Failed to settle thread", () => settleThread(threadRef));
    },
    [park, settleThread],
  );

  const unsettle = useCallback(
    (key: string) => {
      const threadRef = parseScopedThreadKey(key);
      if (threadRef === null) return;
      void unsettleThread(threadRef).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          failureToast("Failed to un-settle thread", squashAtomCommandFailure(result));
        }
      });
    },
    [unsettleThread],
  );

  const unsnooze = useCallback(
    (key: string) => {
      const threadRef = parseScopedThreadKey(key);
      if (threadRef === null) return;
      void unsnoozeThread(threadRef).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          failureToast("Failed to wake thread", squashAtomCommandFailure(result));
        }
      });
    },
    [unsnoozeThread],
  );

  const openSnoozeMenu = useCallback(
    (key: string, position: { x: number; y: number }) => {
      const threadRef = parseScopedThreadKey(key);
      if (threadRef === null) return;
      void (async () => {
        const presets = resolveSnoozePresets(new Date(), timestampFormatRef.current);
        const chosen = await showShellContextMenu(
          presets.map((preset) => ({
            id: `snooze:${preset.id}` as const,
            label: `${preset.label} (${preset.whenLabel})`,
          })),
          { ...position, surface: "shell" },
        );
        const preset = presets.find((candidate) => `snooze:${candidate.id}` === chosen);
        if (!preset) return;
        const snoozed = await park(key, "Failed to snooze thread", () =>
          snoozeThread(threadRef, preset.snoozedUntil),
        );
        if (!snoozed) return;
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: `Snoozed until ${snoozeWakeDescription(preset.snoozedUntil, new Date(), timestampFormatRef.current)}`,
            timeout: 5_000,
            actionProps: {
              children: "Undo",
              onClick: () => unsnooze(key),
            },
          }),
        );
      })();
    },
    [park, snoozeThread, unsnooze],
  );

  const dismissWoke = useCallback(
    (key: string) => {
      const threadRef = parseScopedThreadKey(key);
      const shell = threadRef ? readThreadShell(threadRef) : undefined;
      if (!shell) return;
      const wokeAt = threadWokeAt(shell, { now: new Date().toISOString() });
      if (wokeAt !== null) markThreadVisited(key, wokeAt);
    },
    [markThreadVisited],
  );

  return { settle, unsettle, unsnooze, openSnoozeMenu, dismissWoke };
}
