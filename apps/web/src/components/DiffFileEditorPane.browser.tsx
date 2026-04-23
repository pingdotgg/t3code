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

vi.mock("@monaco-editor/react", async () => {
  const React = await import("react");

  const MockEditor = (props: {
    value?: string;
    onChange?: (value: string | undefined) => void;
    onMount?: (editor: { addCommand: () => void }, monaco: unknown) => void;
  }) => {
    React.useEffect(() => {
      props.onMount?.(
        { addCommand: () => undefined },
        {
          KeyMod: { CtrlCmd: 2048 },
          KeyCode: { KeyS: 49 },
        },
      );
    }, [props]);

    return (
      <textarea
        aria-label="Monaco editor"
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
          initialOverride={undefined}
          resolvedTheme="dark"
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
          initialOverride={undefined}
          resolvedTheme="light"
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
});
