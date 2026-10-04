import type { SelectedWorkItem } from "~/workItemSelection";
import { describe, expect, it, vi } from "vite-plus/test";
import { createWorkItemDraft, workItemTaskPrompt } from "./WorkItemSelectionBar";

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
  it("opens a complete draft with source links and no enrichment step", async () => {
    const setPrompt = vi.fn();
    const clear = vi.fn();
    await expect(
      createWorkItemDraft({
        mode: "compound",
        items: [item],
        openThread: async () => ({ draftId: "draft-1" }),
        setPrompt,
        clear,
        isSelectionCurrent: () => true,
      }),
    ).resolves.toBe(true);
    expect(setPrompt).toHaveBeenCalledExactlyOnceWith(
      "draft-1",
      workItemTaskPrompt("compound", [item]),
    );
    expect(setPrompt.mock.calls[0]?.[1]).toContain(item.url);
    expect(setPrompt.mock.calls[0]?.[1]).not.toContain("Generating");
    expect(clear).toHaveBeenCalledOnce();
  });

  it("uses a single task regardless of the previous multi-selection mode", () => {
    expect(workItemTaskPrompt("subtasks", [item])).toBe(workItemTaskPrompt("compound", [item]));
  });

  it("preserves separate fixes and safely delimits source titles", () => {
    const other = { ...item, number: 13, title: 'A title\n"with quotes"', url: `${item.url}3` };
    const prompt = workItemTaskPrompt("compound", [item, other]);
    expect(prompt).toContain("keep unrelated fixes separate");
    expect(JSON.parse(prompt.split("\n").at(-1)!)).toMatchObject({
      title: other.title,
      number: other.number,
      url: other.url,
    });
    expect(workItemTaskPrompt("subtasks", [item, other])).toContain(
      "subtasks under one parent task",
    );
  });

  it.each([true, false])("only clears a selection still current: %s", async (current) => {
    const clear = vi.fn();
    await createWorkItemDraft({
      mode: "compound",
      items: [item],
      openThread: async () => ({ draftId: "draft-1" }),
      setPrompt: vi.fn(),
      clear,
      isSelectionCurrent: () => current,
    });
    expect(clear).toHaveBeenCalledTimes(current ? 1 : 0);
  });

  it("preserves the selection when a thread cannot open", async () => {
    const setPrompt = vi.fn();
    const clear = vi.fn();
    await expect(
      createWorkItemDraft({
        mode: "compound",
        items: [item],
        openThread: async () => null,
        setPrompt,
        clear,
        isSelectionCurrent: () => true,
      }),
    ).resolves.toBe(false);
    expect(setPrompt).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });
});
