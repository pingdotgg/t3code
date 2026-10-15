// @vitest-environment jsdom
import {
  EnvironmentId,
  PROJECT_READ_FULL_FILE_MAX_BYTES,
  type ProjectReadFileResult,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { FileContentsCopyAction } from "./FileContentsCopyAction";

const { optimisticFile, readFullFile, addToast } = vi.hoisted(() => ({
  optimisticFile: vi.fn<() => ProjectReadFileResult | null>(),
  readFullFile:
    vi.fn<
      (
        environmentId: string,
        cwd: string,
        relativePath: string,
        signal: AbortSignal,
      ) => Promise<string>
    >(),
  addToast: vi.fn(),
}));

vi.mock("./projectFilesQueryState", () => ({
  getOptimisticProjectFileQueryData: optimisticFile,
  readFullProjectFile: readFullFile,
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: addToast },
  stackedThreadToast: (options: unknown) => options,
}));
vi.mock("~/components/MorphIcon", () => ({ MorphIcon: () => null }));

describe("file contents copy action", () => {
  let container: HTMLDivElement;
  let root: Root;
  const writeText = vi.fn<(value: string) => Promise<void>>();
  const props = {
    environmentId: EnvironmentId.make("copy-test"),
    cwd: "/workspace",
    relativePath: "src/example.ts",
    contents: "preview contents",
    truncated: false,
    byteLength: 16,
  };

  const truncatedProps = { ...props, truncated: true, byteLength: 2 * 1024 * 1024 };

  beforeEach(() => {
    optimisticFile.mockReset().mockReturnValue(null);
    readFullFile.mockReset().mockResolvedValue("complete file");
    addToast.mockReset();
    writeText.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function button() {
    const element = container.querySelector("button");
    if (!element) throw new Error("Copy button did not render");
    return element;
  }

  it("copies edits made after render and confirms success", async () => {
    await act(async () => root.render(<FileContentsCopyAction {...props} />));
    optimisticFile.mockReturnValue({
      relativePath: props.relativePath,
      contents: "unsaved edit",
      byteLength: 12,
      truncated: false,
    });

    await act(async () => button().click());

    expect(writeText).toHaveBeenCalledWith("unsaved edit");
    expect(button().getAttribute("aria-label")).toBe("Copied");
    expect(addToast).not.toHaveBeenCalled();
    expect(readFullFile).not.toHaveBeenCalled();
  });

  it("enables copying text added to an empty preview", async () => {
    await act(async () => root.render(<FileContentsCopyAction {...props} contents="" />));
    expect(button().disabled).toBe(true);
    optimisticFile.mockReturnValue({
      relativePath: props.relativePath,
      contents: "new unsaved text",
      byteLength: 16,
      truncated: false,
    });
    await act(async () => root.render(<FileContentsCopyAction {...props} contents="" />));

    expect(button().disabled).toBe(false);
    await act(async () => button().click());

    expect(writeText).toHaveBeenCalledWith("new unsaved text");
    expect(readFullFile).not.toHaveBeenCalled();
  });

  it("disables copying when edits empty a nonempty preview", async () => {
    optimisticFile.mockReturnValue({
      relativePath: props.relativePath,
      contents: "",
      byteLength: 0,
      truncated: false,
    });
    await act(async () => root.render(<FileContentsCopyAction {...props} />));

    expect(button().disabled).toBe(true);
    await act(async () => button().click());
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies the full file beyond the 1 MB preview limit", async () => {
    const fullContents = "x".repeat(2 * 1024 * 1024) + "END OF FULL FILE";
    readFullFile.mockResolvedValue(fullContents);
    await act(async () => root.render(<FileContentsCopyAction {...truncatedProps} />));
    expect(button().getAttribute("aria-label")).toBe("Copy entire file");

    await act(async () => button().click());

    expect(readFullFile).toHaveBeenCalledExactlyOnceWith(
      props.environmentId,
      "/workspace",
      "src/example.ts",
      expect.any(AbortSignal),
    );
    expect(writeText).toHaveBeenCalledWith(fullContents);
    expect(button().getAttribute("aria-label")).toBe("Copied");
  });

  it("starts a deferred clipboard write during the click before reading the full file", async () => {
    const write = vi.fn(async (items: Array<{ data: Record<string, Promise<Blob>> }>) => {
      const blob = await items[0]?.data["text/plain"];
      expect(await blob?.text()).toBe("complete file");
    });
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Promise<Blob>>) {}
      },
    );
    let finishRead: (contents: string) => void = () => {};
    readFullFile.mockReturnValue(
      new Promise<string>((resolve) => {
        finishRead = resolve;
      }),
    );
    await act(async () => root.render(<FileContentsCopyAction {...truncatedProps} />));

    await act(async () => button().click());
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => finishRead("complete file"));

    expect(write).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
    expect(button().getAttribute("aria-label")).toBe("Copied");
  });

  it("reports clipboard denial without claiming success", async () => {
    writeText.mockRejectedValue(new Error("Permission denied"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => root.render(<FileContentsCopyAction {...props} />));

    await act(async () => button().click());

    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Could not copy entire file",
        description: expect.stringContaining("src/example.ts"),
      }),
    );
    expect(button().getAttribute("aria-label")).toBe("Copy entire file");
  });

  it("does not write to the clipboard for an empty preview", async () => {
    await act(async () => root.render(<FileContentsCopyAction {...props} contents="" />));

    await act(async () => button().click());

    expect(writeText).not.toHaveBeenCalled();
  });

  it("clears copy feedback when mounted for a different file", async () => {
    await act(async () => root.render(<FileContentsCopyAction key="first" {...props} />));
    await act(async () => button().click());
    expect(button().getAttribute("aria-label")).toBe("Copied");

    await act(async () =>
      root.render(
        <FileContentsCopyAction
          key="second"
          {...props}
          relativePath="src/second.ts"
          contents="second file"
        />,
      ),
    );
    expect(button().getAttribute("aria-label")).toBe("Copy entire file");
    await act(async () => button().click());
    expect(writeText).toHaveBeenLastCalledWith("second file");
  });

  it("uses complete unsaved contents even when the rendered preview was truncated", async () => {
    await act(async () => root.render(<FileContentsCopyAction {...truncatedProps} />));
    optimisticFile.mockReturnValue({
      relativePath: props.relativePath,
      contents: "complete unsaved contents",
      byteLength: 25,
      truncated: false,
    });

    await act(async () => button().click());

    expect(writeText).toHaveBeenCalledWith("complete unsaved contents");
    expect(readFullFile).not.toHaveBeenCalled();
  });

  it.each(["The file could not be read.", "This file is too large to copy."])(
    "never copies the preview when the full read fails: %s",
    async (message) => {
      readFullFile.mockRejectedValue(new Error(message));
      await act(async () => root.render(<FileContentsCopyAction {...truncatedProps} />));

      await act(async () => button().click());

      expect(writeText).not.toHaveBeenCalled();
      expect(addToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Could not copy entire file",
          description: message,
        }),
      );
      expect(button().getAttribute("aria-label")).toBe("Copy entire file");
    },
  );

  it("disables full reads above the copy limit", async () => {
    await act(async () =>
      root.render(
        <FileContentsCopyAction
          {...truncatedProps}
          byteLength={PROJECT_READ_FULL_FILE_MAX_BYTES + 1}
        />,
      ),
    );

    expect(button().disabled).toBe(true);
    await act(async () => button().click());
    expect(readFullFile).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("allows a full read exactly at the copy limit", async () => {
    await act(async () =>
      root.render(
        <FileContentsCopyAction
          {...truncatedProps}
          byteLength={PROJECT_READ_FULL_FILE_MAX_BYTES}
        />,
      ),
    );

    expect(button().disabled).toBe(false);
    await act(async () => button().click());
    expect(readFullFile).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("complete file");
  });

  it("copies complete optimistic contents instead of an oversized disk file", async () => {
    optimisticFile.mockReturnValue({
      relativePath: props.relativePath,
      contents: "edited contents",
      byteLength: 15,
      truncated: false,
    });
    await act(async () =>
      root.render(
        <FileContentsCopyAction
          {...truncatedProps}
          byteLength={PROJECT_READ_FULL_FILE_MAX_BYTES + 1}
        />,
      ),
    );

    expect(button().disabled).toBe(false);
    await act(async () => button().click());
    expect(writeText).toHaveBeenCalledWith("edited contents");
    expect(readFullFile).not.toHaveBeenCalled();
  });

  it("prevents duplicate reads and cancels the read when the file closes", async () => {
    let finishResponse: (contents: string) => void = () => {
      throw new Error("The file read has not started");
    };
    readFullFile.mockImplementation(
      (_environmentId, _cwd, _relativePath, signal) =>
        new Promise<string>((resolve, reject) => {
          finishResponse = resolve;
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    await act(async () => root.render(<FileContentsCopyAction {...truncatedProps} />));
    await act(async () => button().click());
    expect(button().getAttribute("aria-label")).toBe("Reading file…");
    await act(async () => button().click());
    expect(readFullFile).toHaveBeenCalledTimes(1);

    const signal = readFullFile.mock.calls[0]?.[3];
    await act(async () => root.render(null));
    await act(async () => finishResponse("late file contents"));

    expect(signal?.aborted).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });
});
