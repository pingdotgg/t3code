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

let shownThisSession = false;

function dismiss() {
  try {
    setLocalStorageItem(DISMISSED_KEY, true, Schema.Boolean);
  } catch {}
}

// Every close path, including both buttons, runs `onClose`, which saves the dismissal.
function showStarPrompt() {
  const close = () => toastManager.close(id);
  const id = toastManager.add({
    title: "Enjoying T3 Code?",
    description: "Give us a star on GitHub to let us know!",
    timeout: 0,
    onClose: dismiss,
    actionProps: {
      children: "Star on GitHub",
      onClick: () => {
        close();
        void readLocalApi()
          ?.shell.openExternal(`https://github.com/${REPOSITORY}`)
          .catch(() => undefined);
      },
    },
    data: {
      actionLayout: "stacked-end",
      leadingIcon: <StarIcon aria-hidden className="size-4 text-warning-foreground" />,
      secondaryActionProps: { children: "Dismiss", onClick: close },
      secondaryActionVariant: "ghost",
    },
  });
}

// The server's GitHub account stands in for the user's; it may not be theirs on a shared server.
async function alreadyStarred(environmentId: EnvironmentId) {
  const result = await runAtomCommand(
    appAtomRegistry,
    sourceControlEnvironment.checkStarred,
    {
      environmentId,
      input: {
        provider: SourceControlProviderKind.make("github"),
        host: "github.com",
        repository: REPOSITORY,
      },
    },
    { label: "check GitHub star", reportFailure: false, reportDefect: false },
  );
  return result._tag === "Success" && result.value;
}

/**
 * Counts a sent prompt. After more than five, asks once per session for a star until dismissed,
 * unless the environment's GitHub account already starred the repo.
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
  if (await alreadyStarred(environmentId)) return dismiss();
  try {
    // Another tab can dismiss while the check runs.
    if (getLocalStorageItem(DISMISSED_KEY, Schema.Boolean)) return;
  } catch {
    return;
  }
  showStarPrompt();
}
