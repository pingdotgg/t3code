import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-sparkles-icon", {
  filename: "apps/web/src/components/chat/Example.tsx",
});

describe("t3code/no-sparkles-icon", () => {
  rule.valid(
    "allows icons that name the action",
    `
      import { BotIcon, ShieldCheckIcon } from "lucide-react";
      import IconRobot from "@tabler/icons-react-native/IconRobot";

      const icon = <SymbolView name={{ ios: "puzzlepiece", android: "extension" }} />;
    `,
  );

  rule.valid(
    "allows copy and identifiers that mention sparkles",
    `
      const NIGHTLY_SPARKLES = [];
      const label = "Add some sparkles to the release notes";
    `,
  );

  rule.invalid("reports Lucide sparkles icons", `import { SparklesIcon } from "lucide-react";`);

  rule.invalid(
    "reports every Lucide sparkle variant",
    `import { Sparkle, WandSparklesIcon, LucideSparkles } from "lucide-react";`,
  );

  rule.invalid(
    "reports Tabler sparkles deep imports",
    `import IconSparkles from "@tabler/icons-react-native/IconSparkles";`,
  );

  rule.invalid("reports SF Symbol sparkles names", `const icon = <SymbolView name="sparkles" />;`);

  rule.invalid(
    "reports platform symbol objects",
    `const icon = { ios: "wand.and.sparkles", android: "auto_awesome" };`,
  );
});
