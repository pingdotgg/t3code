import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import {
  WINDOWS_POLICY_GROUPS,
  WINDOWS_POLICY_LISTS,
  WINDOWS_POLICY_VALUES,
} from "@t3tools/shared/managedPolicyFile";

import { macosProfile, windowsAdmx } from "./policyTemplates.ts";

it("gives every registry value the Windows reader accepts a Group Policy control", () => {
  const admx = windowsAdmx();
  for (const name of Object.keys(WINDOWS_POLICY_VALUES)) {
    assert.include(admx, `valueName="${name}"`);
  }
  for (const key of Object.keys(WINDOWS_POLICY_LISTS)) {
    assert.include(admx, `key="SOFTWARE\\Policies\\T3Tools\\T3Code\\${key}"`);
  }
  for (const name of Object.keys(WINDOWS_POLICY_GROUPS)) {
    assert.include(admx, `valueName="${name}"`);
  }
});

it("refuses a profile for a policy with a null value, which a plist cannot hold", () => {
  const profile = macosProfile(
    {
      schemaVersion: 1,
      organization: "Example Corp",
      settings: { defaultModelSelection: { value: null, locked: true } },
    },
    { profile: "profile-uuid", payload: "payload-uuid" },
  );
  assert.deepStrictEqual(profile, {
    _tag: "Invalid",
    reason:
      "settings.defaultModelSelection is null, which a configuration profile cannot hold; deploy this policy as a file.",
  });
});

it("keeps carriage returns in the macOS profile's provider environment strings", () => {
  const profile = macosProfile(
    {
      schemaVersion: 1,
      organization: "Example Corp",
      limits: {
        providers: {
          instances: {
            [ProviderDriverKind.make("claudeAgent")]: {
              locked: true,
              environment: [{ name: "EXAMPLE_PAYLOAD", value: "first\r\nsecond\rthird\n<&>" }],
            },
          },
        },
      },
    },
    { profile: "profile-uuid", payload: "payload-uuid" },
  );
  assert(profile._tag === "Valid");
  assert.include(profile.profile, "<string>first&#13;\nsecond&#13;third\n&lt;&amp;&gt;</string>");
});
