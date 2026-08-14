import { describe, expect, it } from "vite-plus/test";

import { AZURE_DEVOPS_VIEWER_PERMISSIONS } from "./AzureDevOpsPullRequestProvider.ts";

describe("azure devops viewer permissions", () => {
  it("offers every action to whoever is signed in, because Azure names no permission", () => {
    // The same answer for a viewer who can write, one who can only read, and an author with read
    // access: `az repos pr show` and `az repos pr list` carry nothing about the caller's standing,
    // and an unknown permission is granted rather than guessed away. Azure refuses the ones it
    // will not allow, at the moment they are taken, in words this could not have written.
    expect(AZURE_DEVOPS_VIEWER_PERMISSIONS).toEqual({
      actions: [
        "merge",
        "ready",
        "draft",
        "close",
        "reopen",
        "enable-auto-merge",
        "disable-auto-merge",
      ],
      // False because the host itself cannot post one, not because this viewer may not.
      comment: false,
      resolve: false,
      verdicts: [],
      // True because `az repos pr reviewer` does take one, and Azure says nothing about who may.
      requestReviewers: true,
    });
  });
});
