import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { InfoIcon, LoaderIcon, SparklesIcon, XIcon } from "lucide-react";
import { type PropsWithChildren, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useAtomCommand } from "~/state/use-atom-command";
import { generateWorkItemTask } from "~/state/workItems";
import { type SelectedWorkItem, useWorkItemSelection } from "~/workItemSelection";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const WORK_ITEM_MODE_HELP = {
  compound: "Combines the selected items into one task.",
  subtasks: "Splits the selected items into steps under one parent task.",
} as const;

export const WORK_ITEM_SELECTION_BAR_CLASS_NAME =
  "absolute bottom-[calc(env(safe-area-inset-bottom)+1rem)] left-1/2 z-50 flex w-[min(calc(100%-2rem),48rem)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-xl border bg-background/95 p-2 shadow-lg backdrop-blur";

export function workItemGeneratingDraft(
  mode: "compound" | "subtasks",
  items: ReadonlyArray<SelectedWorkItem>,
) {
  return [
    "Generating a task from the selected sources…",
    "",
    mode === "compound" ? "Compound task sources:" : "Parent task sources:",
    ...items.map((item) => `- [${item.title}](${item.url}) (${item.repository}#${item.number})`),
  ].join("\n");
}

function workItemGenerationFailureDraft(
  mode: "compound" | "subtasks",
  items: ReadonlyArray<SelectedWorkItem>,
) {
  return workItemGeneratingDraft(mode, items).replace(
    "Generating a task from the selected sources…",
    "AI task generation failed. You can edit this draft or try again.",
  );
}
type WorkItemTaskGeneration =
  | { readonly _tag: "Failure" }
  | {
      readonly _tag: "Success";
      readonly value: { readonly prompt: string; readonly generated: boolean };
    };

type WorkItemTaskDraftResult =
  | { readonly status: "thread-failure" }
  | { readonly status: "generation-failure" }
  | { readonly status: "success"; readonly generated: boolean };

export async function createGeneratedWorkItemDraft<TDraftId>(input: {
  readonly mode: "compound" | "subtasks";
  readonly items: ReadonlyArray<SelectedWorkItem>;
  readonly openThread: () => Promise<{ readonly draftId: TDraftId } | null>;
  readonly generate: () => Promise<WorkItemTaskGeneration>;
  readonly getPrompt: (draftId: TDraftId) => string | undefined;
  readonly setPrompt: (draftId: TDraftId, prompt: string) => void;
  readonly clear: () => void;
  readonly isSelectionCurrent: () => boolean;
}): Promise<WorkItemTaskDraftResult> {
  const opened = await input.openThread();
  if (opened === null) return { status: "thread-failure" };

  const draft = workItemGeneratingDraft(input.mode, input.items);
  input.setPrompt(opened.draftId, draft);
  const generation = await input.generate();
  if (generation._tag === "Failure") {
    if (input.getPrompt(opened.draftId) === draft)
      input.setPrompt(opened.draftId, workItemGenerationFailureDraft(input.mode, input.items));
    return { status: "generation-failure" };
  }

  if (input.getPrompt(opened.draftId) === draft)
    input.setPrompt(opened.draftId, generation.value.prompt);
  if (input.isSelectionCurrent()) input.clear();
  return { status: "success", generated: generation.value.generated };
}

function WorkItemSelectionBar() {
  const items = useWorkItemSelection((state) => state.items);
  const mode = useWorkItemSelection((state) => state.mode);
  const setMode = useWorkItemSelection((state) => state.setMode);
  const clear = useWorkItemSelection((state) => state.clear);
  const generate = useAtomCommand(generateWorkItemTask, { reportFailure: false });
  const newThread = useNewThreadHandler();
  const [busy, setBusy] = useState(false);

  if (items.length === 0) return null;

  const createTask = async () => {
    const first = items[0];
    if (!first || busy) return;
    setBusy(true);
    const result = await createGeneratedWorkItemDraft({
      mode,
      items,
      openThread: () => newThread(scopeProjectRef(first.environmentId, first.projectId)),
      generate: () =>
        generate({
          environmentId: first.environmentId,
          input: {
            projectId: first.projectId,
            mode,
            items: items.map(({ kind, provider, repository, number }) => ({
              kind,
              provider,
              repository,
              number,
            })),
          },
        }),
      getPrompt: (draftId) => useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt,
      setPrompt: (draftId, prompt) => useComposerDraftStore.getState().setPrompt(draftId, prompt),
      isSelectionCurrent: () => useWorkItemSelection.getState().items === items,
      clear,
    });
    setBusy(false);
    if (result.status === "thread-failure") {
      toastManager.add({ type: "error", title: "Could not open a thread" });
      return;
    }
    if (result.status === "generation-failure") {
      toastManager.add({
        type: "error",
        title: "Could not generate a task",
        description: "The source links are in the draft. You can edit it or try again.",
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: result.generated ? "Task drafted with AI" : "Task drafted",
      description: "Review the task in the composer, then send it.",
    });
  };

  return (
    <div className={WORK_ITEM_SELECTION_BAR_CLASS_NAME}>
      <span className="mr-auto whitespace-nowrap px-1 text-xs text-muted-foreground">
        {items.length} selected
      </span>
      <ToggleGroup
        size="segmented"
        variant="segmented"
        aria-label="Task shape"
        value={[mode]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "compound" || value === "subtasks") setMode(value);
        }}
      >
        {(["compound", "subtasks"] as const).map((value) => (
          <Tooltip key={value}>
            <TooltipTrigger render={<Toggle value={value} />}>
              {value === "compound" ? "Compound" : "Subtasks"}
              <InfoIcon aria-hidden className="ml-1 size-3 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipPopup side="top">{WORK_ITEM_MODE_HELP[value]}</TooltipPopup>
          </Tooltip>
        ))}
      </ToggleGroup>
      <Button size="xs" disabled={busy} onClick={() => void createTask()}>
        {busy ? (
          <LoaderIcon aria-hidden className="size-3.5 animate-spin" />
        ) : (
          <SparklesIcon aria-hidden className="size-3.5" />
        )}
        Create task
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label="Clear selection" onClick={clear}>
        <XIcon aria-hidden className="size-3.5" />
      </Button>
    </div>
  );
}

export function WorkItemSelectionBarHost({ children }: PropsWithChildren) {
  return (
    <div className="relative flex min-w-0 flex-1">
      {children}
      <WorkItemSelectionBar />
    </div>
  );
}
