import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  CodexMicroAction,
  CodexMicroControlId,
  CodexMicroInputEvent,
} from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  codexMicroJoystickControl,
  codexMicroShortcutEvent,
  resolveCodexMicroControl,
} from "../../codexMicro/codexMicroActions";
import { assignCodexMicroSlots, type CodexMicroSlot } from "../../codexMicro/codexMicroSlots";
import {
  isCodexMicroAvailable,
  readCodexMicroSnapshot,
  setCodexMicroSlots,
  subscribeCodexMicroInput,
  useCodexMicroConnected,
} from "../../codexMicro/codexMicroStore";
import { useClientSettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useQuietThreadShells } from "../../state/entities";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import { toastManager } from "../ui/toast";

const AGENT_KEY = /^AG0([0-5])$/;
const JOYSTICK_TRIGGER = 0.5;
const JOYSTICK_RELEASE = 0.2;
// Codex's timings: a second tap within this window focuses the app, and
// holding the knob this long opens its settings.
const DOUBLE_TAP_MS = 350;
const KNOB_LONG_PRESS_MS = 500;

const hasApproval = (thread: SidebarThreadSummary | undefined): thread is SidebarThreadSummary =>
  thread !== undefined &&
  thread.hasPendingApprovals &&
  thread.source.pendingRuntimeRequest !== null;
const isWorking = (thread: SidebarThreadSummary) =>
  thread.runtime !== null &&
  ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status);

const showUnavailable = () =>
  toastManager.add({ type: "warning", title: "This action isn't available here" });

/**
 * Drives a connected Codex Micro: agent keys mirror the six most relevant
 * threads, other controls run T3 commands. Desktop only; the main process
 * owns the HID connection.
 */
export function CodexMicroCoordinator() {
  const connected = useCodexMicroConnected();
  return isCodexMicroAvailable() && connected ? <CodexMicroController /> : null;
}

function useWindowFocused() {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const update = () => setFocused(document.hasFocus());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  return focused;
}

function CodexMicroController() {
  const navigate = useNavigate();
  const settings = useClientSettings((current) => current.codexMicro);
  const environmentId = usePrimaryEnvironmentId();
  const routeThreadId = useParams({ strict: false }).threadId ?? null;
  const windowFocused = useWindowFocused();
  const shells = useQuietThreadShells();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const respondToApproval = useOrchestrationCommand(threadEnvironment.respondToApproval);
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn);
  const joystickArmed = useRef(true);
  const lastAgentTap = useRef<{ index: number; at: number } | null>(null);
  const knobHold = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);

  const threads = shells.filter((thread) => thread.environmentId === environmentId);
  const threadsById = new Map(threads.map((thread) => [thread.id as string, thread]));

  // Like Codex, the selected key is the thread open in T3 Code, and a thread
  // you're looking at no longer reads as unread.
  useEffect(() => {
    const current = readCodexMicroSnapshot();
    const assigned = assignCodexMicroSlots({
      threads,
      previous: current.slots,
      mode: settings.agentMode,
      pinnedThreads: settings.pinnedThreads,
      now: new Date().toISOString(),
    });
    const next = assigned.map((slot): CodexMicroSlot =>
      slot.threadId === routeThreadId && windowFocused && slot.status === "done"
        ? { ...slot, status: "idle" }
        : slot,
    );
    const selected = next.find((slot) => slot.threadId !== null && slot.threadId === routeThreadId);
    const changed = next.some(
      (slot, index) =>
        slot.threadId !== current.slots[index]?.threadId ||
        slot.status !== current.slots[index]?.status ||
        slot.title !== current.slots[index]?.title,
    );
    setCodexMicroSlots(changed ? next : current.slots, selected?.index ?? null);
    const snapshot = readCodexMicroSnapshot();
    void window.desktopBridge?.codexMicro?.setLighting({
      slots: snapshot.slots.map((slot) => ({
        status: slot.status,
        selected: slot.index === snapshot.selectedSlot,
      })),
      brightness: settings.brightness,
      autoDimMs: settings.autoDimMs,
      keysBacklight: settings.keysBacklight,
    });
  }, [threads, routeThreadId, windowFocused, settings]);

  const openSlot = (index: number, focus: boolean) => {
    const slot = readCodexMicroSnapshot().slots[index];
    if (!slot?.threadId || !slot.environmentId) return;
    if (focus) void window.desktopBridge?.revealWindow?.();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(slot.environmentId, slot.threadId)),
    });
  };

  const tapAgentKey = (index: number) => {
    const now = Date.now();
    const previous = lastAgentTap.current;
    const doubleTap = previous?.index === index && now - previous.at <= DOUBLE_TAP_MS;
    lastAgentTap.current = doubleTap ? null : { index, at: now };
    openSlot(index, settings.singleTapFocus || doubleTap);
  };

  const openNeighbor = (step: 1 | -1) => {
    const snapshot = readCodexMicroSnapshot();
    const filled = snapshot.slots.filter((slot) => slot.threadId).map((slot) => slot.index);
    if (filled.length === 0) return;
    const position = snapshot.selectedSlot === null ? -1 : filled.indexOf(snapshot.selectedSlot);
    const next =
      position === -1
        ? filled[step === 1 ? 0 : filled.length - 1]!
        : filled[(position + step + filled.length) % filled.length]!;
    openSlot(next, false);
  };

  // Approvals and stop only act on threads you can see on the keys.
  const keyThreads = () => {
    const snapshot = readCodexMicroSnapshot();
    const selectedId =
      snapshot.selectedSlot === null ? null : snapshot.slots[snapshot.selectedSlot]?.threadId;
    const ids = [selectedId, ...snapshot.slots.map((slot) => slot.threadId)];
    return ids.flatMap((id) => {
      const thread = id ? threadsById.get(id) : undefined;
      return thread ? [thread] : [];
    });
  };

  const runAction = (action: CodexMicroAction) => {
    switch (action.type) {
      case "none":
        return;
      case "nextSlot":
        return openNeighbor(1);
      case "previousSlot":
        return openNeighbor(-1);
      case "focusApp":
        void window.desktopBridge?.revealWindow?.();
        return;
      case "approve":
      case "approveForSession":
      case "decline": {
        const target = keyThreads().find(hasApproval);
        const request = target?.source.pendingRuntimeRequest;
        if (!target || !request) return showUnavailable();
        void respondToApproval({
          environmentId: target.environmentId,
          input: {
            threadId: target.id,
            requestId: request.id,
            decision:
              action.type === "approve"
                ? "accept"
                : action.type === "decline"
                  ? "decline"
                  : "acceptForSession",
          },
        });
        return;
      }
      case "stop": {
        const [selected, ...others] = keyThreads();
        const working = [selected, ...others].filter(
          (thread): thread is SidebarThreadSummary => thread !== undefined && isWorking(thread),
        );
        // With several running threads, stop only the open one.
        const target =
          selected && routeThreadId === selected.id && isWorking(selected)
            ? selected
            : new Set(working.map((thread) => thread.id)).size === 1
              ? working[0]
              : undefined;
        if (!target) return showUnavailable();
        void interruptTurn({ environmentId: target.environmentId, input: { threadId: target.id } });
        return;
      }
      case "command": {
        const init = codexMicroShortcutEvent(keybindings, action.command, navigator.platform);
        if (!init) return showUnavailable();
        const target =
          document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
        target.dispatchEvent(new KeyboardEvent("keydown", init));
        return;
      }
    }
  };

  const runControl = (control: CodexMicroControlId) =>
    runAction(resolveCodexMicroControl(control, settings.knobMode, settings.controls));

  // Holding the knob opens these settings; a short press runs its click action.
  const handleKnobPress = (act: number | null) => {
    if (act === 1 && knobHold.current === null) {
      const hold = {
        fired: false,
        timer: setTimeout(() => {
          hold.fired = true;
          void navigate({ to: "/settings/codex-micro" });
        }, KNOB_LONG_PRESS_MS),
      };
      knobHold.current = hold;
    } else if (act === 0 && knobHold.current !== null) {
      const hold = knobHold.current;
      knobHold.current = null;
      clearTimeout(hold.timer);
      if (!hold.fired) runControl("ENC");
    }
  };

  const handleInput = useEffectEvent((input: CodexMicroInputEvent) => {
    if (input.type === "joystick") {
      if (input.distance < JOYSTICK_RELEASE) joystickArmed.current = true;
      else if (joystickArmed.current && input.distance >= JOYSTICK_TRIGGER) {
        joystickArmed.current = false;
        runControl(codexMicroJoystickControl(input.angle));
      }
      return;
    }
    const agent = AGENT_KEY.exec(input.key);
    if (agent) {
      if (input.act === 1) tapAgentKey(Number(agent[1]));
    } else if (input.key === "ENC_CW" || input.key === "ENC_CC") {
      if (input.act === 2) runControl(input.key);
    } else if (input.key.startsWith("ENC")) {
      handleKnobPress(input.act);
    } else if (input.act === 1 && input.key in settings.controls) {
      // One wide keycap sits on ACT10 + ACT11; like Codex, ignore the second switch.
      if (input.key === "ACT11" && !settings.separateMicrophoneKeys) return;
      runControl(input.key as CodexMicroControlId);
    }
  });

  useEffect(() => {
    const unsubscribe = subscribeCodexMicroInput(handleInput);
    return () => {
      unsubscribe();
      if (knobHold.current) clearTimeout(knobHold.current.timer);
    };
  }, []);
  return null;
}
