import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  requestOlderThreadTurns,
  threadHasOlderTurns,
} from "@t3tools/client-runtime/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import { toastManager } from "../components/ui/toast";
import { downloadPlanAsTextFile } from "../proposedPlan";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, readThreadDetail, waitForThreadDetail } from "../state/entities";
import { environmentThreads, readEnvironmentThreadState } from "../state/threads";
import { stackedThreadToast } from "../components/ui/toastHelpers";

export function formatThreadToMarkdown(
  thread: {
    readonly id: string;
    readonly title?: string;
    readonly createdAt?: string;
    readonly modelSelection?: { readonly instanceId?: string; readonly model?: string } | null;
    readonly messages?: ReadonlyArray<{
      readonly role: string;
      readonly text: string;
      readonly createdAt?: string;
    }>;
  },
  projectTitle?: string,
  options?: {
    readonly isPartial?: boolean;
  },
): string {
  const lines: string[] = [];
  lines.push(`# ${thread.title || "T3 Code Conversation"}\n`);
  if (projectTitle) lines.push(`- **Project:** ${projectTitle}`);
  lines.push(`- **Thread ID:** \`${thread.id}\``);
  if (thread.createdAt) lines.push(`- **Date:** ${new Date(thread.createdAt).toISOString()}`);
  if (thread.modelSelection) {
    lines.push(
      `- **Model:** \`${thread.modelSelection.instanceId ?? "default"}/${thread.modelSelection.model ?? "default"}\``,
    );
  }
  lines.push(`\n---\n`);

  if (options?.isPartial) {
    lines.push(
      `> [!WARNING]\n> **Partial Export**: This transcript contains the ${thread.messages?.length ?? 0} most recent messages. Older history was not loaded.\n\n---\n`,
    );
  }

  for (const msg of thread.messages ?? []) {
    const roleTitle = msg.role === "user" ? "### 👤 User" : "### 🤖 Assistant";
    lines.push(`${roleTitle}\n`);
    lines.push(msg.text.trim());
    lines.push(`\n\n---\n`);
  }

  return lines.join("\n");
}

function waitForNextOlderPage(ref: ScopedThreadRef, timeoutMs = 5000): Promise<void> {
  const initialCount = readThreadDetail(ref)?.messages.length ?? 0;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    let sawLoading = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (unsubscribe) unsubscribe();
    };

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);

    unsubscribe = appAtomRegistry.subscribe(
      environmentThreads.stateAtom(ref.environmentId, ref.threadId),
      (asyncResult) => {
        const currentDetail = readThreadDetail(ref);
        if ((currentDetail?.messages.length ?? 0) > initialCount) {
          cleanup();
          resolve();
          return;
        }
        const state = Option.getOrNull(AsyncResult.value(asyncResult));
        if (!state) return;
        const page = Option.getOrNull(state.page);
        if (page?.loadingOlder) {
          sawLoading = true;
        } else if (sawLoading) {
          cleanup();
          resolve();
        }
      },
    );
  });
}

export async function exportThreadAsMarkdown(threadRef: ScopedThreadRef): Promise<boolean> {
  const detail = await waitForThreadDetail(threadRef);
  if (!detail) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Export failed",
        description: "Could not load conversation messages. Please try again.",
      }),
    );
    return false;
  }

  if (!detail.messages || detail.messages.length === 0) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Export unavailable",
        description: "This conversation has no messages to export.",
      }),
    );
    return false;
  }

  let state = readEnvironmentThreadState(threadRef.environmentId, threadRef.threadId);
  let hasMore = threadHasOlderTurns(state);
  let pagesLoaded = 0;
  const maxPages = 20;

  while (hasMore && pagesLoaded < maxPages) {
    const requested = requestOlderThreadTurns(threadRef.environmentId, threadRef.threadId);
    if (!requested) break;
    await waitForNextOlderPage(threadRef, 5000);
    pagesLoaded++;
    state = readEnvironmentThreadState(threadRef.environmentId, threadRef.threadId);
    hasMore = threadHasOlderTurns(state);
  }

  const finalDetail = readThreadDetail(threadRef) ?? detail;
  const isPartial = hasMore;
  const project = readProject(scopeProjectRef(threadRef.environmentId, finalDetail.projectId));
  const markdown = formatThreadToMarkdown(
    {
      id: finalDetail.id,
      title: finalDetail.title,
      createdAt: finalDetail.createdAt,
      modelSelection: finalDetail.modelSelection,
      messages: finalDetail.messages,
    },
    project?.title,
    { isPartial },
  );

  const safeTitle = (finalDetail.title || "conversation")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");

  downloadPlanAsTextFile(`${safeTitle}.md`, markdown);

  if (isPartial) {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Conversation exported (partial)",
        description: `Saved ${safeTitle}.md with the ${finalDetail.messages.length} most recent messages.`,
      }),
    );
  } else {
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Conversation exported",
        description: `Saved ${safeTitle}.md`,
      }),
    );
  }
  return true;
}
