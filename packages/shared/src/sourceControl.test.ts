import { SourceControlProviderKind } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { getChangeRequestTerminologyForKind } from "./sourceControl.ts";

it("calls a Forgejo change request a pull request", () => {
  expect(getChangeRequestTerminologyForKind(SourceControlProviderKind.make("forgejo"))).toEqual({
    shortLabel: "PR",
    singular: "pull request",
  });
});
