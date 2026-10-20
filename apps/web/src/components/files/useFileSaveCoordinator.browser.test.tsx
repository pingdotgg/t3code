import { render, fakeTimers } from "../../../test/render";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { StrictMode, useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const { writeFile, confirmFile, readScope, getUnsavedFile } = vi.hoisted(() => ({
  writeFile: vi.fn(),
  confirmFile: vi.fn(),
  readScope: vi.fn(),
  getUnsavedFile: vi.fn(),
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: readScope,
  useEnvironmentScope: readScope,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => writeFile) as never,
}));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  confirmProjectFileQueryData: confirmFile,
  getUnsavedProjectFileQueryData: getUnsavedFile,
}));

import { setMarkdownTaskChecked } from "./filePreviewMode";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";

const environmentId = EnvironmentId.make("save-lifecycle-audit");
const onPendingChange = vi.fn();
const defaultProps = {
  environmentId,
  cwd: "/workspace",
  relativePath: "file.txt",
  onPendingChange,
};
function setup() {
  writeFile.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  confirmFile.mockReset();
  readScope.mockReset().mockReturnValue(true);
  getUnsavedFile.mockReset().mockReturnValue(null);
  onPendingChange.mockReset();
}

async function mount(props = defaultProps) {
  let latestChange: (contents: string) => void = () => {};
  function FileSurface(props: Parameters<typeof useFileSaveCoordinator>[0]) {
    const coordinator = useFileSaveCoordinator(props);
    useEffect(() => {
      latestChange = (contents) => coordinator.change(contents);
    });
    return null;
  }
  const ui = (props: Parameters<typeof useFileSaveCoordinator>[0]) => (
    <StrictMode>
      <FileSurface {...props} />
    </StrictMode>
  );
  const screen = await render(ui(props), { router: false });
  return {
    changeHandler: () => latestChange,
    rerender: (props: Parameters<typeof useFileSaveCoordinator>[0]) => screen.rerender(ui(props)),
    unmount: screen.unmount,
    [Symbol.asyncDispose]: () => screen[Symbol.asyncDispose](),
  };
}

describe("file-save React lifecycle", () => {
  it("persists editor model changes after StrictMode setup replay", async () => {
    setup();
    using _timers = fakeTimers();
    await using screen = await mount();
    screen.changeHandler()("AUDIT7907NATIVE\n");
    expect(onPendingChange).toHaveBeenCalledWith("file.txt", true);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "AUDIT7907NATIVE\n" },
    });
    expect(confirmFile).toHaveBeenCalledExactlyOnceWith(
      environmentId,
      "/workspace",
      "file.txt",
      "AUDIT7907NATIVE\n",
    );
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("persists rendered Markdown task changes after StrictMode setup replay", async () => {
    setup();
    using _timers = fakeTimers();
    await using screen = await mount({ ...defaultProps, relativePath: "README.md" });
    const nextContents = setMarkdownTaskChecked("- [ ] task\n", 2, true);
    screen.changeHandler()(nextContents);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "README.md", contents: "- [x] task\n" },
    });
  });

  it("keeps the debounce across rerenders of the same file", async () => {
    setup();
    using _timers = fakeTimers();
    await using screen = await mount();
    screen.changeHandler()("first");
    await vi.advanceTimersByTimeAsync(300);
    await screen.rerender(defaultProps);
    screen.changeHandler()("latest");
    await vi.advanceTimersByTimeAsync(499);
    expect(writeFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("latest");
  });

  it("flushes on unmount and ignores a retired editor callback", async () => {
    setup();
    using _timers = fakeTimers();
    await using screen = await mount();
    const retiredChange = screen.changeHandler();
    retiredChange("pending edit");
    await screen.unmount();
    retiredChange("stale editor contents");
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("pending edit");
  });

  it.each([false, true])(
    "keeps edits pending after permission is revoked before a React update (unmount: %s)",
    async (unmount) => {
      setup();
      using _timers = fakeTimers();
      await using screen = await mount();
      screen.changeHandler()("pending edit");
      readScope.mockReturnValue(false);
      if (unmount) {
        await screen.unmount();
      }
      await vi.runAllTimersAsync();
      expect(writeFile).not.toHaveBeenCalled();
      expect(confirmFile).not.toHaveBeenCalled();
      expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", true);
    },
  );

  it("resumes an unsaved draft when write permission returns after effect replay", async () => {
    setup();
    using _timers = fakeTimers();
    readScope.mockReturnValue(false);
    getUnsavedFile.mockReturnValue({ contents: "pending draft" });
    await using screen = await mount();
    await vi.runAllTimersAsync();
    expect(writeFile).not.toHaveBeenCalled();

    readScope.mockReturnValue(true);
    await screen.rerender(defaultProps);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "pending draft" },
    });
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("recovers an existing draft once after StrictMode setup replay", async () => {
    setup();
    using _timers = fakeTimers();
    getUnsavedFile.mockReturnValue({ contents: "reopened draft" });
    await using _screen = await mount();
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "reopened draft" },
    });
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it.each([
    { relativePath: "other.txt" },
    { cwd: "/other-workspace" },
    { environmentId: EnvironmentId.make("other-environment") },
  ])("retires callbacks when the file identity changes: %j", async (change) => {
    setup();
    using _timers = fakeTimers();
    await using screen = await mount();
    const retiredChange = screen.changeHandler();
    retiredChange("old file edit");
    const nextProps = { ...defaultProps, ...change };
    await screen.rerender(nextProps);
    retiredChange("stale editor contents");
    screen.changeHandler()("new file edit");
    await vi.runAllTimersAsync();
    expect(writeFile.mock.calls.map(([request]) => request)).toEqual([
      {
        environmentId,
        input: { cwd: "/workspace", relativePath: "file.txt", contents: "old file edit" },
      },
      {
        environmentId: nextProps.environmentId,
        input: {
          cwd: nextProps.cwd,
          relativePath: nextProps.relativePath,
          contents: "new file edit",
        },
      },
    ]);
  });

  it("does not reactivate a retired callback when the same file mounts again", async () => {
    setup();
    using _timers = fakeTimers();
    await using screen = await mount();
    const retiredChange = screen.changeHandler();
    await screen.unmount();
    await using reopened = await mount();
    retiredChange("stale contents");
    reopened.changeHandler()("current contents");
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("current contents");
  });
});
