import { useAtomValue } from "@effect/atom-react";
import { quickChatModelSelection } from "@t3tools/client-runtime/operations/quickChats";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { DEFAULT_RUNTIME_MODE, type EnvironmentId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import { newThreadId } from "../lib/utils";
import { waitForThreadShell } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { toastManager } from "../components/ui/toast";

export function useNewQuickChat() {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const create = useAtomCommand(threadEnvironment.create, "Create quick chat");
  const router = useRouter();
  const pending = useRef(false);
  return useCallback(
    async (environmentId: EnvironmentId) => {
      if (pending.current) return;
      const config = configs.get(environmentId);
      if (!config?.environment.capabilities.quickChats) return;
      const modelSelection = quickChatModelSelection(config);
      if (!modelSelection) {
        toastManager.add({ type: "error", title: "Set up an agent before starting a quick chat" });
        return;
      }
      pending.current = true;
      const href = router.state.location.href;
      try {
        const threadId = newThreadId();
        const result = await create({
          environmentId,
          input: {
            threadId,
            projectId: null,
            title: "New quick chat",
            modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: new Date().toISOString(),
          },
        });
        if (result._tag !== "Success") {
          if (!isAtomCommandInterrupted(result))
            toastManager.add({ type: "error", title: "Could not create quick chat" });
          return;
        }
        await waitForThreadShell({ environmentId, threadId });
        if (router.state.location.href === href) {
          await router.navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId },
          });
        }
      } finally {
        pending.current = false;
      }
    },
    [configs],
  );
}
