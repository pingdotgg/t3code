import type { GitHubStatusResult, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";
import { toastManager } from "~/components/ui/toast";
import { readNativeApi } from "~/nativeApi";

interface RefetchStatusResult {
  data: GitHubStatusResult | undefined;
  error: Error | null;
}

interface UseGitPanelGitHubActionsInput {
  isGitHubAuthenticated: boolean;
  githubRepoUrl: string | null;
  issuesErrorMessage: string | null;
  login: () => void;
  refetchStatus: () => Promise<RefetchStatusResult>;
  threadToastData: { threadId: ThreadId } | undefined;
}

export function useGitPanelGitHubActions({
  isGitHubAuthenticated,
  githubRepoUrl,
  issuesErrorMessage,
  login,
  refetchStatus,
  threadToastData,
}: UseGitPanelGitHubActionsInput) {
  const openExternalUrl = useCallback(
    async (url: string) => {
      const api = readNativeApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Link unavailable",
          data: threadToastData,
        });
        return;
      }

      await api.shell.openExternal(url);
    },
    [threadToastData],
  );

  const verifyGitHubAuth = useCallback(async () => {
    const result = await refetchStatus();

    if (result.error) {
      toastManager.add({
        type: "error",
        title: "Verification failed",
        description: result.error.message,
        data: threadToastData,
      });
      return;
    }

    if (!result.data?.installed) {
      toastManager.add({
        type: "warning",
        title: "gh not installed",
        description: "Install GitHub CLI to enable features",
        data: threadToastData,
      });
      return;
    }

    if (!result.data.authenticated) {
      toastManager.add({
        type: "warning",
        title: "gh not authenticated",
        description: "Run auth flow to connect",
        data: threadToastData,
      });
      return;
    }

    toastManager.add({
      type: "success",
      title: "GitHub verified",
      description: result.data.accountLogin ? `@${result.data.accountLogin}` : undefined,
      data: threadToastData,
    });
  }, [refetchStatus, threadToastData]);

  const runAuthAction = useCallback(() => {
    if (isGitHubAuthenticated) {
      void verifyGitHubAuth();
      return;
    }
    login();
  }, [isGitHubAuthenticated, login, verifyGitHubAuth]);

  const issuesDisabled = issuesErrorMessage?.toLowerCase().includes("disabled issues") ?? false;

  return {
    githubRepoUrl,
    issuesDisabled,
    openExternalUrl,
    runAuthAction,
  };
}
