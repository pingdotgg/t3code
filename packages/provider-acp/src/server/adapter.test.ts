import { describe, expect, it } from "vite-plus/test";

import { acpUnnamedTextEndsInsideCode } from "./adapter.ts";

describe("acpUnnamedTextEndsInsideCode", () => {
  it("detects text ending inside an unclosed inline code span or code fence", () => {
    expect(
      acpUnnamedTextEndsInsideCode("Permissions (config `umask 027` app `0750` & keyring `0"),
    ).toBe(true);
    expect(acpUnnamedTextEndsInsideCode("Use ``git status`` and ``npm test")).toBe(true);
    expect(acpUnnamedTextEndsInsideCode("Look at `foo.")).toBe(true);
    expect(acpUnnamedTextEndsInsideCode("Here is the script:\n```bash\necho 'done.'\n")).toBe(true);
    expect(acpUnnamedTextEndsInsideCode("~~~\nls\n")).toBe(true);
  });

  it("treats closed code and plain text as safe to split", () => {
    expect(acpUnnamedTextEndsInsideCode("Let me check `config.json`.")).toBe(false);
    expect(acpUnnamedTextEndsInsideCode("Use \\`escaped\\` ticks.")).toBe(false);
    expect(acpUnnamedTextEndsInsideCode("Here is the script:\n```bash\necho ok\n```\n")).toBe(
      false,
    );
    expect(acpUnnamedTextEndsInsideCode("I'll search **/*.ts for usages.")).toBe(false);
    expect(acpUnnamedTextEndsInsideCode("Checking")).toBe(false);
    expect(acpUnnamedTextEndsInsideCode("")).toBe(false);
  });
});
