import "../index.css";

import { type EnvironmentApi, EnvironmentId } from "@forma/contracts";
import { parsePatchFiles } from "@pierre/diffs";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import { DiffFileEditorPane } from "./DiffFileEditorPane";

const { focusMock, revealPositionInCenterMock, setPositionMock } = vi.hoisted(() => ({
  focusMock: vi.fn(),
  revealPositionInCenterMock: vi.fn(),
  setPositionMock: vi.fn(),
}));

function offsetToPosition(text: string, offset: number) {
  const safeOffset = Math.max(0, Math.min(text.length, offset));
  const lines = text.slice(0, safeOffset).split("\n");
  const lineNumber = lines.length;
  const column = (lines.at(-1)?.length ?? 0) + 1;
  return { lineNumber, column };
}

function positionToOffset(text: string, lineNumber: number, column: number) {
  const lines = text.split("\n");
  let offset = 0;
  for (let index = 0; index < Math.max(0, lineNumber - 1); index += 1) {
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return offset + Math.max(0, column - 1);
}

vi.mock("@monaco-editor/react", async () => {
  const React = await import("react");

  const MockEditor = (props: {
    language?: string;
    value?: string;
    onChange?: (value: string | undefined) => void;
    onMount?: (
      editor: {
        addCommand: () => void;
        focus: () => void;
        getModel: () => {
          getLineCount: () => number;
          getLineMaxColumn: (lineNumber: number) => number;
        };
        revealPositionInCenter: (position: { lineNumber: number; column: number }) => void;
        setPosition: (position: { lineNumber: number; column: number }) => void;
      },
      monaco: unknown,
    ) => void;
  }) => {
    const { language, onChange, onMount, value } = props;
    const valueRef = React.useRef(props.value ?? "");
    const selectionRef = React.useRef({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    });
    const selectionListenersRef = React.useRef<Array<() => void>>([]);

    function syncSelection(target: HTMLTextAreaElement) {
      const start = target.selectionStart ?? 0;
      const end = target.selectionEnd ?? start;
      const startPosition = offsetToPosition(target.value, start);
      const endPosition = offsetToPosition(target.value, end);
      selectionRef.current = {
        startLineNumber: startPosition.lineNumber,
        startColumn: startPosition.column,
        endLineNumber: endPosition.lineNumber,
        endColumn: endPosition.column,
      };
      for (const listener of selectionListenersRef.current) {
        listener();
      }
    }

    React.useEffect(() => {
      valueRef.current = value ?? "";
    }, [value]);

    React.useEffect(() => {
      const editor = {
        addCommand: () => undefined,
        focus: focusMock,
        getModel: () => ({
          getLineCount: () => Math.max(1, valueRef.current.split("\n").length),
          getLineMaxColumn: (lineNumber: number) =>
            (valueRef.current.split("\n")[lineNumber - 1]?.length ?? 0) + 1,
          getValueInRange: (range: {
            startLineNumber: number;
            startColumn: number;
            endLineNumber: number;
            endColumn: number;
          }) =>
            valueRef.current.slice(
              positionToOffset(valueRef.current, range.startLineNumber, range.startColumn),
              positionToOffset(valueRef.current, range.endLineNumber, range.endColumn),
            ),
        }),
        getSelection: () => selectionRef.current,
        onDidChangeCursorSelection: (listener: () => void) => {
          selectionListenersRef.current.push(listener);
          return {
            dispose: () => {
              selectionListenersRef.current = selectionListenersRef.current.filter(
                (entry) => entry !== listener,
              );
            },
          };
        },
        onDidScrollChange: () => ({
          dispose: () => undefined,
        }),
        onDidLayoutChange: () => ({
          dispose: () => undefined,
        }),
        getScrolledVisiblePosition: (position: { lineNumber: number; column: number }) => ({
          top: (position.lineNumber - 1) * 20,
          left: Math.max(0, (position.column - 1) * 8),
          height: 20,
        }),
        getTopForLineNumber: (lineNumber: number) => (lineNumber - 1) * 20,
        getScrollTop: () => 0,
        revealPositionInCenter: revealPositionInCenterMock,
        setPosition: setPositionMock,
      };
      onMount?.(editor, {
        KeyMod: { CtrlCmd: 2048 },
        KeyCode: { KeyS: 49 },
      });
    }, [onMount]);

    return (
      <textarea
        aria-label="Monaco editor"
        data-language={language ?? ""}
        className="h-full w-full"
        value={value ?? ""}
        onSelect={(event) => syncSelection(event.currentTarget)}
        onMouseUp={(event) => syncSelection(event.currentTarget)}
        onKeyUp={(event) => syncSelection(event.currentTarget)}
        onChange={(event) => onChange?.(event.currentTarget.value)}
      />
    );
  };

  return {
    __esModule: true,
    default: MockEditor,
    loader: {
      config: () => undefined,
    },
  };
});

const environmentId = EnvironmentId.make("environment-local");
const versionA = "a".repeat(64);
const versionB = "b".repeat(64);

function getSingleFileDiff(patch: string) {
  const parsed = parsePatchFiles(patch, "diff-file-editor-pane:browser");
  const fileDiff = parsed.flatMap((entry) => entry.files)[0];
  if (!fileDiff) {
    throw new Error("Expected a parsed file diff.");
  }
  return fileDiff;
}

function setEnvironmentApiOverride(input: {
  readFile: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
}) {
  __setEnvironmentApiOverrideForTests(environmentId, {
    projects: {
      readFile: input.readFile,
      searchEntries: vi.fn(),
      writeFile: input.writeFile,
    },
  } as unknown as EnvironmentApi);
}

function selectEditorText(start: number, end: number) {
  const textarea = document.querySelector('textarea[aria-label="Monaco editor"]');
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error("Expected the Monaco editor textarea to exist.");
  }
  textarea.focus();
  textarea.setSelectionRange(start, end);
  textarea.dispatchEvent(new Event("select", { bubbles: true }));
  textarea.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

describe("DiffFileEditorPane", () => {
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    vi.restoreAllMocks();
    focusMock.mockReset();
    revealPositionInCenterMock.mockReset();
    setPositionMock.mockReset();
    document.body.innerHTML = "";
  });

  it("saves the edited file and forwards the reconstructed pre-turn contents", async () => {
    const readFile = vi.fn().mockResolvedValue({
      relativePath: "src/example.ts",
      contents: "const value = 2;\nconst extra = true;\n",
      version: versionA,
    });
    const writeFile = vi.fn().mockResolvedValue({
      relativePath: "src/example.ts",
      version: versionB,
    });
    setEnvironmentApiOverride({ readFile, writeFile });

    const onPersisted = vi.fn().mockResolvedValue(undefined);
    const fileDiff = getSingleFileDiff(`diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1,2 @@
-const value = 1;
+const value = 2;
+const extra = true;
`);

    const screen = await render(
      <div className="h-[640px] w-[960px]">
        <DiffFileEditorPane
          cwd="/repo"
          environmentId={environmentId}
          fileDiff={fileDiff}
          filePath="src/example.ts"
          filePaths={["src/example.ts", "src/other.ts"]}
          navigationLabel="Back to diff"
          initialOverride={undefined}
          resolvedPreset="stone"
          onAddCodeContext={vi.fn()}
          onOpenInEditor={vi.fn()}
          onPersisted={onPersisted}
          onRequestBack={vi.fn()}
          onRequestFilePathChange={vi.fn()}
        />
      </div>,
    );

    try {
      await expect.element(page.getByLabelText("Monaco editor")).toBeVisible();
      await page.getByLabelText("Monaco editor").fill("const value = 4;\nconst extra = true;\n");
      await page.getByRole("button", { name: "Save" }).click();

      expect(writeFile).toHaveBeenCalledWith({
        cwd: "/repo",
        relativePath: "src/example.ts",
        contents: "const value = 4;\nconst extra = true;\n",
        expectedVersion: versionA,
      });
      expect(onPersisted).toHaveBeenCalledWith({
        filePath: "src/example.ts",
        savedContents: "const value = 4;\nconst extra = true;\n",
        preTurnContents: "const value = 1;\n",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("asks for confirmation before switching files with unsaved edits", async () => {
    const readFile = vi.fn().mockResolvedValue({
      relativePath: "src/example.ts",
      contents: "const value = 2;\n",
      version: versionA,
    });
    const writeFile = vi.fn().mockResolvedValue({
      relativePath: "src/example.ts",
      version: versionB,
    });
    setEnvironmentApiOverride({ readFile, writeFile });

    const onRequestFilePathChange = vi.fn();
    const screen = await render(
      <div className="h-[640px] w-[960px]">
        <DiffFileEditorPane
          cwd="/repo"
          environmentId={environmentId}
          fileDiff={null}
          filePath="src/example.ts"
          filePaths={["src/example.ts", "src/other.ts"]}
          navigationLabel="Back to diff"
          initialOverride={undefined}
          resolvedPreset="light"
          onAddCodeContext={vi.fn()}
          onOpenInEditor={vi.fn()}
          onPersisted={vi.fn()}
          onRequestBack={vi.fn()}
          onRequestFilePathChange={onRequestFilePathChange}
        />
      </div>,
    );

    try {
      await expect.element(page.getByLabelText("Monaco editor")).toBeVisible();
      await page.getByLabelText("Monaco editor").fill("const value = 3;\n");
      await page.getByRole("button", { name: "other.ts" }).click();

      await expect.element(page.getByRole("heading", { name: "Unsaved changes" })).toBeVisible();
      expect(onRequestFilePathChange).not.toHaveBeenCalled();

      await page.getByRole("button", { name: "Discard" }).click();

      expect(onRequestFilePathChange).toHaveBeenCalledWith("src/other.ts");
    } finally {
      await screen.unmount();
    }
  });

  it("uses the TypeScript Monaco language for TSX files", async () => {
    const readFile = vi.fn().mockResolvedValue({
      relativePath: "src/example.tsx",
      contents: "export function Example() { return <div />; }\n",
      version: versionA,
    });
    const writeFile = vi.fn().mockResolvedValue({
      relativePath: "src/example.tsx",
      version: versionB,
    });
    setEnvironmentApiOverride({ readFile, writeFile });

    const screen = await render(
      <div className="h-[640px] w-[960px]">
        <DiffFileEditorPane
          cwd="/repo"
          environmentId={environmentId}
          fileDiff={null}
          filePath="src/example.tsx"
          filePaths={["src/example.tsx"]}
          navigationLabel="Back to diff"
          initialOverride={undefined}
          resolvedPreset="stone"
          onAddCodeContext={vi.fn()}
          onOpenInEditor={vi.fn()}
          onPersisted={vi.fn()}
          onRequestBack={vi.fn()}
          onRequestFilePathChange={vi.fn()}
        />
      </div>,
    );

    try {
      await expect
        .element(page.getByLabelText("Monaco editor"))
        .toHaveAttribute("data-language", "typescript");
    } finally {
      await screen.unmount();
    }
  });

  it("positions the editor cursor from the initial line and column and renders the navigation label", async () => {
    const readFile = vi.fn().mockResolvedValue({
      relativePath: "src/example.ts",
      contents: "const first = 1;\nconst second = 2;\n",
      version: versionA,
    });
    const writeFile = vi.fn().mockResolvedValue({
      relativePath: "src/example.ts",
      version: versionB,
    });
    setEnvironmentApiOverride({ readFile, writeFile });

    const screen = await render(
      <div className="h-[640px] w-[960px]">
        <DiffFileEditorPane
          cwd="/repo"
          environmentId={environmentId}
          fileDiff={null}
          filePath="src/example.ts"
          filePaths={["src/example.ts"]}
          initialColumn={7}
          initialLine={2}
          navigationLabel="Exit edit"
          initialOverride={undefined}
          resolvedPreset="stone"
          onAddCodeContext={vi.fn()}
          onOpenInEditor={vi.fn()}
          onPersisted={vi.fn()}
          onRequestBack={vi.fn()}
          onRequestFilePathChange={vi.fn()}
        />
      </div>,
    );

    try {
      await expect.element(page.getByRole("button", { name: "Exit edit" })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Open in IDE" })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Save" })).toBeVisible();
      await expect.element(page.getByText("⌘", { exact: true })).toBeVisible();
      await expect.element(page.getByText("src/example.ts")).not.toBeInTheDocument();
      await vi.waitFor(() => {
        expect(revealPositionInCenterMock).toHaveBeenCalledWith({ lineNumber: 2, column: 7 });
        expect(setPositionMock).toHaveBeenCalledWith({ lineNumber: 2, column: 7 });
        expect(focusMock).toHaveBeenCalled();
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows Add to chat for a valid code selection and forwards the normalized selection", async () => {
    const readFile = vi.fn().mockResolvedValue({
      relativePath: "src/example.ts",
      contents: "const value = 2;\nconst extra = true;\n",
      version: versionA,
    });
    const writeFile = vi.fn().mockResolvedValue({
      relativePath: "src/example.ts",
      version: versionB,
    });
    setEnvironmentApiOverride({ readFile, writeFile });

    const onAddCodeContext = vi.fn();
    const screen = await render(
      <div className="h-[640px] w-[960px]">
        <DiffFileEditorPane
          cwd="/repo"
          environmentId={environmentId}
          fileDiff={null}
          filePath="src/example.ts"
          filePaths={["src/example.ts"]}
          navigationLabel="Back to diff"
          initialOverride={undefined}
          resolvedPreset="stone"
          onAddCodeContext={onAddCodeContext}
          onOpenInEditor={vi.fn()}
          onPersisted={vi.fn()}
          onRequestBack={vi.fn()}
          onRequestFilePathChange={vi.fn()}
        />
      </div>,
    );

    try {
      await expect.element(page.getByLabelText("Monaco editor")).toBeVisible();
      const value = "const value = 2;\nconst extra = true;\n";
      selectEditorText(0, value.indexOf("\n", value.indexOf("\n") + 1) + 1);

      await expect
        .element(page.getByRole("button", { name: "Add selected code to chat" }))
        .toBeVisible();
      await page.getByRole("button", { name: "Add selected code to chat" }).click();

      expect(onAddCodeContext).toHaveBeenCalledWith({
        filePath: "src/example.ts",
        lineStart: 1,
        lineEnd: 2,
        text: "const value = 2;\nconst extra = true;",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("does not show Add to chat for a whitespace-only selection", async () => {
    const readFile = vi.fn().mockResolvedValue({
      relativePath: "src/example.ts",
      contents: "const value = 2;\n\nconst extra = true;\n",
      version: versionA,
    });
    const writeFile = vi.fn().mockResolvedValue({
      relativePath: "src/example.ts",
      version: versionB,
    });
    setEnvironmentApiOverride({ readFile, writeFile });

    const screen = await render(
      <div className="h-[640px] w-[960px]">
        <DiffFileEditorPane
          cwd="/repo"
          environmentId={environmentId}
          fileDiff={null}
          filePath="src/example.ts"
          filePaths={["src/example.ts"]}
          navigationLabel="Back to diff"
          initialOverride={undefined}
          resolvedPreset="stone"
          onAddCodeContext={vi.fn()}
          onOpenInEditor={vi.fn()}
          onPersisted={vi.fn()}
          onRequestBack={vi.fn()}
          onRequestFilePathChange={vi.fn()}
        />
      </div>,
    );

    try {
      await expect.element(page.getByLabelText("Monaco editor")).toBeVisible();
      const value = "const value = 2;\n\nconst extra = true;\n";
      const blankLineStart = value.indexOf("\n") + 1;
      selectEditorText(blankLineStart, blankLineStart + 1);

      await expect
        .element(page.getByRole("button", { name: "Add selected code to chat" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("disables Add to chat when the selection exceeds the size limit", async () => {
    const largeContents = Array.from({ length: 201 }, (_, index) => `line ${index + 1};`).join(
      "\n",
    );
    const readFile = vi.fn().mockResolvedValue({
      relativePath: "src/example.ts",
      contents: largeContents,
      version: versionA,
    });
    const writeFile = vi.fn().mockResolvedValue({
      relativePath: "src/example.ts",
      version: versionB,
    });
    setEnvironmentApiOverride({ readFile, writeFile });

    const screen = await render(
      <div className="h-[640px] w-[960px]">
        <DiffFileEditorPane
          cwd="/repo"
          environmentId={environmentId}
          fileDiff={null}
          filePath="src/example.ts"
          filePaths={["src/example.ts"]}
          navigationLabel="Back to diff"
          initialOverride={undefined}
          resolvedPreset="stone"
          onAddCodeContext={vi.fn()}
          onOpenInEditor={vi.fn()}
          onPersisted={vi.fn()}
          onRequestBack={vi.fn()}
          onRequestFilePathChange={vi.fn()}
        />
      </div>,
    );

    try {
      await expect.element(page.getByLabelText("Monaco editor")).toBeVisible();
      selectEditorText(0, largeContents.length);

      await expect
        .element(page.getByRole("button", { name: "Add selected code to chat" }))
        .toBeDisabled();
      await expect
        .element(page.getByRole("button", { name: "Add selected code to chat" }))
        .toHaveAttribute("title", "Selections are limited to 200 lines or 12,000 characters.");
    } finally {
      await screen.unmount();
    }
  });
});
