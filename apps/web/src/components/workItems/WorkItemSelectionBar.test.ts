import type { SelectedWorkItem } from "~/workItemSelection";
import { describe, expect, it } from "vite-plus/test";

import {
  createGeneratedWorkItemDraft,
  WORK_ITEM_MODE_HELP,
  WORK_ITEM_SELECTION_BAR_CLASS_NAME,
  workItemGeneratingDraft,
} from "./WorkItemSelectionBar";
type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((next) => {
      resolve = next;
    }),
    resolve,
  };
}

const item: SelectedWorkItem = {
  kind: "issue",
  provider: "github",
  environmentId: "environment-1" as SelectedWorkItem["environmentId"],
  projectId: "project-1" as SelectedWorkItem["projectId"],
  repository: "acme/app",
  number: 12,
  title: "Fix session refresh",
  url: "https://github.com/acme/app/issues/12",
};

describe("work item task draft", () => {
  it("centers selected-item actions inside the list column", () => {
    expect(WORK_ITEM_SELECTION_BAR_CLASS_NAME).toContain("absolute");
    expect(WORK_ITEM_SELECTION_BAR_CLASS_NAME).toContain(
      "bottom-[calc(env(safe-area-inset-bottom)+1rem)]",
    );
    expect(WORK_ITEM_SELECTION_BAR_CLASS_NAME).toContain("w-[min(calc(100%-2rem),48rem)]");
    expect(WORK_ITEM_SELECTION_BAR_CLASS_NAME).not.toContain("100vw");
  });

  it("shows the exact help for each task shape", () => {
    expect(WORK_ITEM_MODE_HELP).toEqual({
      compound: "One task that merges overlap and orders dependencies.",
      subtasks: "One parent task split into ordered child steps.",
    });
  });

  it("opens a marked draft before AI generation resolves", async () => {
    const generation = deferred<
      | { readonly _tag: "Failure" }
      | {
          readonly _tag: "Success";
          readonly value: { readonly prompt: string; readonly generated: boolean };
        }
    >();
    let prompt: string | undefined;
    let opened = false;

    const creating = createGeneratedWorkItemDraft({
      mode: "compound",
      items: [item],
      openThread: async () => {
        opened = true;
        return { draftId: "draft-1" };
      },
      generate: () => generation.promise,
      getPrompt: () => prompt,
      setPrompt: (_draftId, next) => {
        prompt = next;
      },
      isSelectionCurrent: () => true,
      clear: () => undefined,
    });

    await Promise.resolve();
    expect(opened).toBe(true);
    expect(prompt).toBe(workItemGeneratingDraft("compound", [item]));

    generation.resolve({ _tag: "Success", value: { prompt: "AI task", generated: true } });
    await expect(creating).resolves.toEqual({ status: "success", generated: true });
  });

  it("does not replace a marked draft after the user edits it", async () => {
    const generation = deferred<
      | { readonly _tag: "Failure" }
      | {
          readonly _tag: "Success";
          readonly value: { readonly prompt: string; readonly generated: boolean };
        }
    >();
    let prompt: string | undefined;

    const creating = createGeneratedWorkItemDraft({
      mode: "subtasks",
      items: [item],
      openThread: async () => ({ draftId: "draft-1" }),
      generate: () => generation.promise,
      getPrompt: () => prompt,
      setPrompt: (_draftId, next) => {
        prompt = next;
      },
      isSelectionCurrent: () => true,
      clear: () => undefined,
    });

    await Promise.resolve();
    prompt = "My edited task";
    generation.resolve({ _tag: "Success", value: { prompt: "AI task", generated: true } });
    await creating;

    expect(prompt).toBe("My edited task");
  });

  it("keeps a newer selection when an older generation completes", async () => {
    const generation = deferred<{
      readonly _tag: "Success";
      readonly value: { readonly prompt: string; readonly generated: boolean };
    }>();
    let prompt: string | undefined;
    let clears = 0;
    const creating = createGeneratedWorkItemDraft({
      mode: "compound",
      items: [item],
      openThread: async () => ({ draftId: "draft-1" }),
      generate: () => generation.promise,
      getPrompt: () => prompt,
      setPrompt: (_draftId, next) => {
        prompt = next;
      },
      isSelectionCurrent: () => false,
      clear: () => {
        clears += 1;
      },
    });

    await Promise.resolve();
    generation.resolve({ _tag: "Success", value: { prompt: "AI task", generated: true } });
    await creating;

    expect(clears).toBe(0);
  });

  it("replaces an untouched generating marker after generation fails", async () => {
    let prompt: string | undefined;
    const creating = createGeneratedWorkItemDraft({
      mode: "compound",
      items: [item],
      openThread: async () => ({ draftId: "draft-1" }),
      generate: async () => ({ _tag: "Failure" }),
      getPrompt: () => prompt,
      setPrompt: (_draftId, next) => {
        prompt = next;
      },
      isSelectionCurrent: () => true,
      clear: () => undefined,
    });

    await expect(creating).resolves.toEqual({ status: "generation-failure" });

    expect(prompt).toContain("AI task generation failed");
    expect(prompt).toContain(item.url);
    expect(prompt).not.toContain("Generating a task");
  });

  it("keeps an edited draft when generation fails", async () => {
    const generation = deferred<{ readonly _tag: "Failure" }>();
    let prompt: string | undefined;
    const creating = createGeneratedWorkItemDraft({
      mode: "subtasks",
      items: [item],
      openThread: async () => ({ draftId: "draft-1" }),
      generate: () => generation.promise,
      getPrompt: () => prompt,
      setPrompt: (_draftId, next) => {
        prompt = next;
      },
      isSelectionCurrent: () => true,
      clear: () => undefined,
    });

    await Promise.resolve();
    prompt = "My edited task";
    generation.resolve({ _tag: "Failure" });
    await creating;

    expect(prompt).toBe("My edited task");
  });
});
