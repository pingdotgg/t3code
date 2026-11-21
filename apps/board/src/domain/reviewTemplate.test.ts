import { describe, expect, it } from "vite-plus/test";

import { pickTemplate, SYSTEM_TEMPLATE, templateFacts } from "./reviewTemplate";

describe("review templates", () => {
  it("Given the system template, when its facts render, then they are the review-loop skill's checks and lanes", () => {
    expect(templateFacts(SYSTEM_TEMPLATE)).toBe(
      [
        "- The review template is `Review loop`. Run it on every ticket, with the review-loop skill's rules.",
        "  - Author checks, which the builder runs before it reports code-ready: `simplify`, `no-comments`, `unslop`, `pre-pr-reviewer`.",
        "  - Reviewer lanes, which you start after it, each as its own child:",
        "    - `ponytail-review`: always.",
        "    - `test-evidence-review`: when the diff adds or changes tests.",
        "    - `security-audit` in guidance mode: when the diff renders outside content, handles a key or token, or writes outside the app.",
        "    - `receipts`: when the work claims test runs, screenshots, or other evidence; check each claim against its file.",
      ].join("\n"),
    );
  });

  it("Given a board's pick, when it resolves, then a missing or unknown name is the system template", () => {
    const custom = [{ name: "Security only", authorChecks: [], lanes: [] }];
    expect(pickTemplate("Security only", custom)).toBe(custom[0]);
    expect(pickTemplate(undefined, custom)).toBe(SYSTEM_TEMPLATE);
    expect(pickTemplate("Deleted", custom)).toBe(SYSTEM_TEMPLATE);
  });
});
