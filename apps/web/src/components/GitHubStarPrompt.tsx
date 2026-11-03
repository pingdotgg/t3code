import { type EnvironmentId, SourceControlProviderKind } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { StarIcon } from "lucide-react";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { sourceControlEnvironment } from "../state/sourceControl";
import { toastManager } from "./ui/toast";

// Separate keys so a count written by another tab can never undo a dismissal.
const SENT_KEY = "t3code:github-star-prompt:sent";
const DISMISSED_KEY = "t3code:github-star-prompt:dismissed";
const REPOSITORY = "pingdotgg/t3code";
const PROMPTS_BEFORE_ASKING = 5;
const IDLE_MS = 30_000;
// User-driven actions (send, navigate, type, scroll) start with one of these; touch fires pointerdown.
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "focus"] as const;

let shownThisSession = false;

function dismiss() {
  try {
    setLocalStorageItem(DISMISSED_KEY, true, Schema.Boolean);
  } catch {}
}

// Every close path, including both buttons, runs `onClose`, which saves the dismissal.
function showStarPrompt(environmentId: EnvironmentId) {
  const close = () => toastManager.close(id);
  const openInBrowser = () => {
    close();
    void readLocalApi()
      ?.shell.openExternal(`https://github.com/${REPOSITORY}`)
      .catch(() => undefined);
  };
  const starInPlace = async () => {
    toastManager.update(id, { actionProps: { children: "Starring…", disabled: true } });
    if (await starRepository(environmentId)) {
      close();
      toastManager.add({ type: "success", title: "Thanks for the star!", timeout: 4_000 });
      return;
    }
    // Browsers block new tabs once the click's activation expires; desktop opens through its bridge.
    if (window.desktopBridge || navigator.userActivation?.isActive !== false)
      return openInBrowser();
    toastManager.update(id, { actionProps: { children: "Open GitHub", onClick: openInBrowser } });
  };
  const id = toastManager.add({
    title: "Enjoying T3 Code?",
    description: "Give us a star on GitHub to let us know!",
    timeout: 0,
    onClose: dismiss,
    actionProps: { children: "Star on GitHub", onClick: () => void starInPlace() },
    data: {
      actionLayout: "stacked-end",
      leadingIcon: <StarIcon aria-hidden className="size-4 text-warning-foreground" />,
      secondaryActionProps: { children: "Dismiss", onClick: close },
      secondaryActionVariant: "ghost",
    },
  });
}

// Resolves after IDLE_MS without input while this window has focus.
function waitForIdle() {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restart = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Input inside another app or an embedded frame never reaches us; the next focus restarts.
        if (!document.hasFocus() || document.activeElement?.matches("iframe, webview")) return;
        for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, restart, true);
        resolve();
      }, IDLE_MS);
    };
    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, restart, { capture: true, passive: true });
    }
    restart();
  });
}

// The server's GitHub account stands in for the user's; it may not be theirs on a shared server.
const starInput = (environmentId: EnvironmentId) => ({
  environmentId,
  input: {
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    repository: REPOSITORY,
  },
});

async function alreadyStarred(environmentId: EnvironmentId) {
  const result = await runAtomCommand(
    appAtomRegistry,
    sourceControlEnvironment.checkStarred,
    starInput(environmentId),
    { label: "check GitHub star", reportFailure: false, reportDefect: false },
  );
  return result._tag === "Success" ? result.value : undefined;
}

async function starRepository(environmentId: EnvironmentId) {
  const result = await runAtomCommand(
    appAtomRegistry,
    sourceControlEnvironment.star,
    starInput(environmentId),
    { label: "star on GitHub", reportFailure: false, reportDefect: false },
  );
  return result._tag === "Success" && result.value;
}

/**
 * Counts a sent prompt. After more than five, asks once per session for a star until dismissed,
 * unless the environment's GitHub account already starred the repo. Waits until the user is idle.
 */
export async function recordPromptSent(environmentId: EnvironmentId): Promise<void> {
  if (shownThisSession) return;
  try {
    if (getLocalStorageItem(DISMISSED_KEY, Schema.Boolean)) return;
    const sent = (getLocalStorageItem(SENT_KEY, Schema.Number) ?? 0) + 1;
    setLocalStorageItem(SENT_KEY, sent, Schema.Number);
    if (sent <= PROMPTS_BEFORE_ASKING) return;
  } catch {
    // Storage that cannot be read or written could not keep a dismissal, so never ask.
    return;
  }
  shownThisSession = true;
  const starred = await alreadyStarred(environmentId);
  if (starred === undefined) return;
  if (starred) return dismiss();
  await waitForIdle();
  try {
    // Another tab can dismiss while the check or the idle wait runs.
    if (getLocalStorageItem(DISMISSED_KEY, Schema.Boolean)) return;
  } catch {
    return;
  }
  showStarPrompt(environmentId);
}
