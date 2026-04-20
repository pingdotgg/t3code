import { describe, expect, it } from "vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import { GithubCopilotIcon } from "../Icons";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

describe("providerIconUtils", () => {
  it("uses the dedicated GitHub Copilot icon for the copilot provider", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("copilot")]).toBe(GithubCopilotIcon);
  });
});
