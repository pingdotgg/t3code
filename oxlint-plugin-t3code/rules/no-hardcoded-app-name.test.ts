import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-hardcoded-app-name", {
  filename: "apps/web/src/components/Example.tsx",
});

describe("t3code/no-hardcoded-app-name", () => {
  rule.valid(
    "allows the name in comments and the placeholder in copy",
    `
      // Opens T3 Code settings.
      const label = gt("Open {appName} settings", { appName: appName() });
    `,
  );

  rule.valid("allows comparing against the default name", `const stock = name === "T3 Code";`);

  rule.valid(
    "allows a suppression with a reason",
    `
      // oxlint-disable-next-line t3code/no-hardcoded-app-name -- legacy directory name on disk
      const legacy = "T3 Code (Dev)";
    `,
  );

  rule.invalid("reports a string literal", `const label = gt("Open T3 Code settings");`);

  rule.invalid("reports a template literal", "const label = `${count} T3 Code windows`;");

  rule.invalid("reports JSX text", `const node = <T>Restart T3 Code to finish.</T>;`);
});
