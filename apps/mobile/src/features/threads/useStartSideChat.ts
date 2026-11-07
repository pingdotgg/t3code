import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { MessageId, ThreadId, type ModelSelection, type ScopedThreadRef } from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForThreadShell } from "./threadForkNavigation";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

/**
 * Forks `source` at its latest stable point into a side chat, sends `prompt` there on
 * `modelSelection`, and opens it like any linked thread. Resolves false when the side chat
 * did not start.
 */
export function useStartSideChat() {
  const forkSideChat = useAtomCommand(threadEnvironment.forkSideChat, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const openLinkedThread = useOpenLinkedThread();

  const alertFailure = (
    failure: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
    fallback: string,
  ) => {
    if (isAtomCommandInterrupted(failure)) return;
    const error = squashAtomCommandFailure(failure);
    Dialog.alert("Side chat not started", error instanceof Error ? error.message : fallback);
  };

  return async (
    source: ScopedThreadRef,
    prompt: string,
    modelSelection: ModelSelection,
  ): Promise<boolean> => {
    const targetThreadId = ThreadId.make(uuidv4());
    const fork = await forkSideChat({
      environmentId: source.environmentId,
      input: {
        sourceThreadId: source.threadId,
        targetThreadId,
        title: "Side chat",
        creationSource: "mobile",
      },
    });
    if (fork._tag === "Failure") {
      alertFailure(fork, "Could not start a side chat.");
      return false;
    }
    // Drops the empty side chat a failed start leaves behind; one that got its message stays.
    const discard = () =>
      void deleteThread({
        environmentId: source.environmentId,
        input: { threadId: targetThreadId, onlyIfUnused: true },
      });
    const targetRef = scopeThreadRef(source.environmentId, targetThreadId);
    if (!(await waitForThreadShell(targetRef))) {
      Dialog.alert(
        "Side chat not started",
        "The side chat was created, but it did not reach this device.",
      );
      discard();
      return false;
    }
    const sideChat = appAtomRegistry.get(environmentThreadShells.threadShellAtom(targetRef));
    if (sideChat === null) {
      Dialog.alert("Side chat not started", "The side chat is no longer available.");
      discard();
      return false;
    }
    const turn = await startTurn({
      environmentId: source.environmentId,
      input: {
        threadId: targetThreadId,
        message: {
          messageId: MessageId.make(uuidv4()),
          role: "user",
          text: prompt,
          attachments: [],
        },
        titleSeed: deriveThreadTitleSeed({ text: prompt, attachments: [] }),
        modelSelection,
        runtimeMode: sideChat.runtimeMode,
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      },
    });
    if (turn._tag === "Failure") {
      alertFailure(turn, "Could not send the side chat message.");
      discard();
      return false;
    }
    openLinkedThread({ environmentId: source.environmentId, threadId: targetThreadId });
    return true;
  };
}
