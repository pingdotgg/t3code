import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/max-settings-description-length", {
  filename: "apps/web/src/components/settings/Example.tsx",
});

const long = "Agents ".repeat(30);

describe("t3code/max-settings-description-length", () => {
  rule.valid(
    "allows a short description",
    `const row = <SettingsRow title="Theme" description="Choose how T3 Code looks." />;`,
  );

  rule.valid(
    "does not count dynamic text",
    `const row = <SettingsRow title="Task" description={\`${long.slice(0, 150)}\${prompt}\`} />;`,
  );

  rule.invalid(
    "reports a long string description",
    `const row = <SettingsRow title="Theme" description="${long}" />;`,
  );

  rule.invalid(
    "counts link text inside a JSX description",
    `
      const row = (
        <SettingsRow
          title="Guests"
          description={
            <>
              ${long.slice(0, 150)}{" "}
              <Link to="/docs">${long.slice(0, 60)}</Link>
            </>
          }
        />
      );
    `,
  );
});
