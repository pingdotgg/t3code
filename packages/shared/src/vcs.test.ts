import { assert, describe, it } from "vite-plus/test";
import {
  GIT_VCS_TERMINOLOGY,
  JJ_VCS_TERMINOLOGY,
  resolveVcsTerminology,
  supportsVcsActions,
} from "./vcs.ts";

describe("VCS presentation and explicit capability", () => {
  it("keeps singleton terminology identities and permits unknown status", () => {
    assert.strictEqual(resolveVcsTerminology(null), GIT_VCS_TERMINOLOGY);
    assert.strictEqual(resolveVcsTerminology({ vcs: { kind: "jj" } }), JJ_VCS_TERMINOLOGY);
    assert.isTrue(supportsVcsActions(null));
    assert.isTrue(supportsVcsActions(undefined));
    assert.isTrue(supportsVcsActions({ vcs: { kind: "jj" } }));
    assert.isTrue(supportsVcsActions({ vcs: { kind: "git", notice: "Using Git." } }));
    assert.strictEqual(
      resolveVcsTerminology({ vcs: { kind: "git", notice: "Using Git." } }),
      GIT_VCS_TERMINOLOGY,
    );
    assert.isFalse(
      supportsVcsActions({ vcs: { kind: "jj", unsupportedReason: "Enable colocation." } }),
    );
  });
  it("preserves surface-specific original Git copy", () => {
    assert.equal(
      GIT_VCS_TERMINOLOGY.noRefHint("pushing", "web"),
      "Detached HEAD: check out a branch before pushing.",
    );
    assert.equal(
      GIT_VCS_TERMINOLOGY.noRefHint("pushing", "mobile"),
      "Detached HEAD: checkout a branch before pushing.",
    );
    assert.equal(
      GIT_VCS_TERMINOLOGY.featureCheckoutLabel("web"),
      "Check out feature branch & continue",
    );
    assert.equal(GIT_VCS_TERMINOLOGY.featureCheckoutLabel("mobile"), "Feature branch & continue");
    assert.equal(GIT_VCS_TERMINOLOGY.changeOnNewRefLabel, "Commit on new branch");
    assert.equal(GIT_VCS_TERMINOLOGY.repositoryAdjective, "git");
  });
  it("uses the requested bookmark copy without Git hooks or branch promises", () => {
    assert.equal(JJ_VCS_TERMINOLOGY.changeOnNewRefLabel, "Change on new bookmark");
    assert.equal(JJ_VCS_TERMINOLOGY.featureCheckoutLabel("web"), "Check out feature bookmark");
    assert.equal(JJ_VCS_TERMINOLOGY.featureCheckoutLabel("mobile"), "Check out feature bookmark");
    assert.equal(JJ_VCS_TERMINOLOGY.hooksNotice, "Jujutsu does not run Git hooks.");
    assert.equal(JJ_VCS_TERMINOLOGY.defaultRefLabel, "Warning: default bookmark");
    assert.equal(JJ_VCS_TERMINOLOGY.repositoryAdjective, "Jujutsu");
  });
});
