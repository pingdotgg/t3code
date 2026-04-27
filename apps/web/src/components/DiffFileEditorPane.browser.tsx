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
    const valueRef = React.useRef(props.value ?? "");
    React.useEffect(() => {
      valueRef.current = props.value ?? "";
    }, [props.value]);

    React.useEffect(() => {
      props.onMount?.(
        {
          addCommand: () => undefined,
          focus: focusMock,
          getModel: () => ({
            getLineCount: () => Math.max(1, valueRef.current.split("\n").length),
            getLineMaxColumn: (lineNumber: number) =>
              (valueRef.current.split("\n")[lineNumber - 1]?.length ?? 0) + 1,
          }),
          revealPositionInCenter: revealPositionInCenterMock,
          setPosition: setPositionMock,
        },
        {
          KeyMod: { CtrlCmd: 2048 },
          KeyCode: { KeyS: 49 },
        },
      );
    }, [props]);

    return (
      <textarea
        aria-label="Monaco editor"
        data-language={props.language ?? ""}
        className="h-full w-full"
        value={props.value ?? ""}
        onChange={(event) => props.onChange?.(event.currentTarget.value)}
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
});
