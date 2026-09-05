import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useLocation, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useThreadShells } from "../state/entities";
import { useUiStateStore } from "../uiStateStore";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import {
  attentionNotificationTitle,
  resolveNextAttentionThreadKey,
  resolveThreadAttention,
  sortAttentionItems,
  type ThreadAttentionItem,
} from "../attentionQueue";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { stackedThreadToast, toastManager } from "./ui/toast";

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

function threadKeyFor(shell: EnvironmentThreadShell): string {
  return scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id));
}

function attentionItemsForThreads(
  threads: readonly EnvironmentThreadShell[],
  lastVisitedAtById: Readonly<Record<string, string>>,
  acknowledgedById: Readonly<Record<string, string>>,
): ThreadAttentionItem[] {
  return sortAttentionItems(
    threads.flatMap((thread) => {
      const threadKey = threadKeyFor(thread);
      const item = resolveThreadAttention({
        thread,
        threadKey,
        lastVisitedAt: lastVisitedAtById[threadKey],
        acknowledgedAttentionKey: acknowledgedById[threadKey],
      });
      return item ? [item] : [];
    }),
  );
}

function toastTypeForAttention(item: ThreadAttentionItem): "error" | "info" | "success" {
  if (item.state === "failed") return "error";
  if (item.state === "ready") return "success";
  return "info";
}

export function ThreadAttentionQueue() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const navigate = useNavigate();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const threads = useThreadShells();
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const acknowledgedById = useUiStateStore((state) => state.threadAttentionAcknowledgedById);
  const acknowledgeThreadAttention = useUiStateStore((state) => state.acknowledgeThreadAttention);
  const currentThreadKey =
    routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;
  const attentionItems = useMemo(
    () => attentionItemsForThreads(threads, lastVisitedAtById, acknowledgedById),
    [acknowledgedById, lastVisitedAtById, threads],
  );
  const attentionItemsByKey = useMemo(
    () => new Map(attentionItems.map((item) => [item.threadKey, item] as const)),
    [attentionItems],
  );
  const shortcutLabel = shortcutLabelForCommand(keybindings, "thread.nextAttention") ?? "⌥L";
  const toastIdsByThreadKey = useRef(new Map<string, ReturnType<typeof toastManager.add>>());
  const initializedRef = useRef(false);
  const previousAttentionKeysRef = useRef(new Map<string, string>());

  const openAttentionItem = useCallback(
    (item: ThreadAttentionItem) => {
      acknowledgeThreadAttention(item.threadKey, item.attentionKey);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(item.thread.environmentId, item.thread.id)),
      });
    },
    [acknowledgeThreadAttention, navigate],
  );

  useEffect(() => {
    if (pathname.startsWith("/settings") || routeTarget?.kind !== "server") return;
    const item = attentionItemsByKey.get(currentThreadKey ?? "");
    if (item) acknowledgeThreadAttention(item.threadKey, item.attentionKey);
  }, [
    acknowledgeThreadAttention,
    attentionItemsByKey,
    currentThreadKey,
    pathname,
    routeTarget?.kind,
  ]);

  useEffect(() => {
    const currentKeys = new Set(attentionItemsByKey.keys());
    for (const [threadKey, toastId] of toastIdsByThreadKey.current) {
      if (!currentKeys.has(threadKey)) {
        toastManager.close(toastId);
        toastIdsByThreadKey.current.delete(threadKey);
      }
    }

    const previousAttentionKeys = previousAttentionKeysRef.current;
    if (initializedRef.current) {
      for (const item of attentionItems) {
        const previousKey = previousAttentionKeys.get(item.threadKey);
        if (previousKey === item.attentionKey || item.threadKey === currentThreadKey) continue;

        const toast = stackedThreadToast({
          type: toastTypeForAttention(item),
          title: attentionNotificationTitle(item),
          description: `${shortcutLabel} to review next`,
          timeout: 0,
          data: {
            onClose: () => acknowledgeThreadAttention(item.threadKey, item.attentionKey),
          },
          actionProps: {
            children: "Open",
            onClick: () => openAttentionItem(item),
          },
        });
        const existingToastId = toastIdsByThreadKey.current.get(item.threadKey);
        if (existingToastId) {
          toastManager.update(existingToastId, toast);
        } else {
          toastIdsByThreadKey.current.set(item.threadKey, toastManager.add(toast));
        }
      }
    }

    previousAttentionKeysRef.current = new Map(
      attentionItems.map((item) => [item.threadKey, item.attentionKey]),
    );
    initializedRef.current = true;
  }, [
    acknowledgeThreadAttention,
    attentionItems,
    attentionItemsByKey,
    currentThreadKey,
    openAttentionItem,
    shortcutLabel,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.key === "Unidentified" ||
        isCommandPaletteOpen() ||
        isTerminalFocused() ||
        isTextEntryTarget(event.target) ||
        pathname.startsWith("/settings") ||
        routeTarget?.kind !== "server"
      ) {
        return;
      }
      if (
        resolveShortcutCommand(event, keybindings, {
          context: { terminalFocus: false, terminalOpen: false },
        }) !== "thread.nextAttention"
      ) {
        return;
      }

      const targetKey = resolveNextAttentionThreadKey({
        items: attentionItems,
        currentThreadKey,
      });
      const target = targetKey ? attentionItemsByKey.get(targetKey) : undefined;
      if (!target) return;

      event.preventDefault();
      event.stopPropagation();
      openAttentionItem(target);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    attentionItems,
    attentionItemsByKey,
    currentThreadKey,
    keybindings,
    openAttentionItem,
    pathname,
    routeTarget?.kind,
  ]);

  return null;
}
