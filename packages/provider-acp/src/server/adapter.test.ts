import { describe, expect, it } from "vite-plus/test";

import { acpChunkContinuesUnnamedText, acpClassifyUnnamedTextBoundaryForTool } from "./adapter.ts";

describe("acpClassifyUnnamedTextBoundaryForTool", () => {
  it("keeps unnamed text open inside an unclosed code span or fence, or mid-phrase", () => {
    expect(
      acpClassifyUnnamedTextBoundaryForTool(
        "Permissions (config `umask 027` app `0750` & keyring `0",
      ),
    ).toBe("open");
    expect(acpClassifyUnnamedTextBoundaryForTool("Use ``git status`` and ``npm test")).toBe("open");
    expect(acpClassifyUnnamedTextBoundaryForTool("Look at `foo.")).toBe("open");
    expect(
      acpClassifyUnnamedTextBoundaryForTool("Here is the script:\n```bash\necho 'done.'\n"),
    ).toBe("open");
    expect(acpClassifyUnnamedTextBoundaryForTool("First, inspect bootstrap,")).toBe("open");
    expect(acpClassifyUnnamedTextBoundaryForTool("   ")).toBe("open");
  });

  it("closes unnamed text at clean sentence and block boundaries", () => {
    expect(acpClassifyUnnamedTextBoundaryForTool("Let me check the config file.")).toBe("close");
    expect(acpClassifyUnnamedTextBoundaryForTool("Inspecting the files:")).toBe("close");
    expect(acpClassifyUnnamedTextBoundaryForTool("Should I run the suite?")).toBe("close");
    expect(acpClassifyUnnamedTextBoundaryForTool("Running the tests!")).toBe("close");
    expect(acpClassifyUnnamedTextBoundaryForTool("Let me check `config.json`.")).toBe("close");
    expect(acpClassifyUnnamedTextBoundaryForTool("Checking (quick pass).")).toBe("close");
    expect(acpClassifyUnnamedTextBoundaryForTool("**Checking config.**")).toBe("close");
    expect(acpClassifyUnnamedTextBoundaryForTool("I'll search **/*.ts for usages.")).toBe("close");
    expect(acpClassifyUnnamedTextBoundaryForTool("Open (see [docs](x).")).toBe("close");
    expect(acpClassifyUnnamedTextBoundaryForTool("Use \\`escaped\\` ticks.")).toBe("close");
    expect(
      acpClassifyUnnamedTextBoundaryForTool("Here is the script:\n```bash\necho ok\n```\n"),
    ).toBe("close");
    expect(acpClassifyUnnamedTextBoundaryForTool("Summary:\n- item 1\n- item 2\n")).toBe("close");
  });

  it("defers ambiguous word or table boundaries until the next chunk arrives", () => {
    expect(acpClassifyUnnamedTextBoundaryForTool("Checking the conf")).toBe("defer");
    expect(acpClassifyUnnamedTextBoundaryForTool("Checking")).toBe("defer");
    expect(acpClassifyUnnamedTextBoundaryForTool("Check `config.json`")).toBe("defer");
    expect(acpClassifyUnnamedTextBoundaryForTool("Use Open")).toBe("defer");
    expect(acpClassifyUnnamedTextBoundaryForTool("2. **Surface 1 (")).toBe("defer");
    expect(acpClassifyUnnamedTextBoundaryForTool("The script configures ")).toBe("defer");
    expect(acpClassifyUnnamedTextBoundaryForTool("Step 1 finished. ")).toBe("defer");
    expect(acpClassifyUnnamedTextBoundaryForTool("| a | b |\n|---|---|\n| 1 | x |\n")).toBe(
      "defer",
    );
  });
});

describe("acpChunkContinuesUnnamedText", () => {
  it("recognizes mid-word, mid-sentence, and table continuations vs fresh replies", () => {
    expect(acpChunkContinuesUnnamedText("Checking the conf", "ig file.")).toBe(true);
    expect(acpChunkContinuesUnnamedText("The script sets umask", " 027.")).toBe(true);
    expect(acpChunkContinuesUnnamedText("Check `config.json`", ", then restart.")).toBe(true);
    expect(acpChunkContinuesUnnamedText("Check foo", "-bar")).toBe(true);
    expect(acpChunkContinuesUnnamedText("| a | b |\n|---|---|\n| 1 | x |\n", "| 2 | y |\n")).toBe(
      true,
    );
    expect(acpChunkContinuesUnnamedText("| a | b |\n|---|---|\n| 1 | x |", "\n| 2 | y |")).toBe(
      true,
    );

    expect(acpChunkContinuesUnnamedText("Checking", "Found the issue.")).toBe(false);
    expect(acpChunkContinuesUnnamedText("Checking", "- First finding")).toBe(false);
    expect(acpChunkContinuesUnnamedText("Checking", "## Summary")).toBe(false);
    expect(acpChunkContinuesUnnamedText("Checking", "\nDone.")).toBe(false);
    expect(acpChunkContinuesUnnamedText("| a | b |\n|---|---|\n| 1 | x |\n", "Next section.")).toBe(
      false,
    );
  });
});
