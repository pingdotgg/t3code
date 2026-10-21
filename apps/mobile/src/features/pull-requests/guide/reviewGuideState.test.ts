import { describe, expect, it } from "vite-plus/test";
import {
  IsoDateTime,
  ProviderInstanceId,
  type PullRequestReviewGuideResult,
} from "@t3tools/contracts";
import { reviewGuideState } from "./reviewGuideState";

const guide: NonNullable<PullRequestReviewGuideResult["guide"]> = {
  headSha: "old-head",
  generatedAt: IsoDateTime.make("2026-10-11T00:00:00.000Z"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  stops: [],
};

describe("mobile review guide state", () => {
  it("keeps a previous guide readable during a rewrite", () => {
    const state = reviewGuideState({
      guide,
      currentHeadSha: "new-head",
      run: { _tag: "Running", headSha: "new-head", startedAt: guide.generatedAt },
    });
    expect(state).toMatchObject({ guide, stale: true, running: true, failure: null });
  });
});
