import type { ScopedThreadRef } from "@t3tools/contracts";

export function composerAgentSelectionKey(input: {
  readonly activeThreadId: string | null;
  readonly activeEnvironmentId: string | null;
  readonly activeProjectId: string | null;
  readonly draftId: string | null;
  readonly composerDraftTarget: ScopedThreadRef | string;
}): string {
  const target =
    typeof input.composerDraftTarget === "string"
      ? (["draft", input.composerDraftTarget] as const)
      : ([
          "thread",
          input.composerDraftTarget.environmentId,
          input.composerDraftTarget.threadId,
        ] as const);
  return JSON.stringify([
    input.activeEnvironmentId,
    input.activeProjectId,
    input.activeThreadId,
    input.draftId,
    target,
  ]);
}
