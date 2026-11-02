import { describe, expect, it } from "vite-plus/test";
import {
  IsoDateTime,
  ProviderInstanceId,
  type PullRequestReviewGuideResult,
} from "@t3tools/contracts";
import { guideNoticeState, shouldAutoGenerateGuide } from "./reviewGuideState";

const guide: NonNullable<PullRequestReviewGuideResult["guide"]> = {
  headSha: "old-head",
  generatedAt: IsoDateTime.make("2026-10-11T00:00:00.000Z"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  stops: [],
};

const view = {
  data: null,
  isPending: false,
  running: false,
  startError: null,
  error: null,
  canWrite: true,
};

describe("guide notice transitions", () => {
  it("moves from loading into automatic generation without a manual action", () => {
    expect(guideNoticeState({ ...view, isPending: true }).kind).toBe("loading");
    expect(
      guideNoticeState({ ...view, data: { guide: null, run: null, currentHeadSha: "head" } }).kind,
    ).toBe("writing");
  });

  it("waits for write access without claiming generation has started", () => {
    expect(
      guideNoticeState({
        ...view,
        canWrite: false,
        data: { guide: null, run: null, currentHeadSha: "head" },
      }).kind,
    ).toBe("empty");
  });

  it("automatically writes for a new head after a previous head failed", () => {
    const data: PullRequestReviewGuideResult = {
      guide: null,
      currentHeadSha: "new-head",
      run: {
        _tag: "Failed",
        headSha: "old-head",
        failedAt: guide.generatedAt,
        detail: "Writer disconnected",
      },
    };
    expect(shouldAutoGenerateGuide({ ...view, data })).toBe(true);
    expect(guideNoticeState({ ...view, data }).kind).toBe("writing");
    const failedHead = { ...data, currentHeadSha: "old-head" };
    expect(shouldAutoGenerateGuide({ ...view, data: failedHead })).toBe(false);
    expect(guideNoticeState({ ...view, data: failedHead }).kind).toBe("failed");
  });

  it("does not auto-start without data or permission, during a run, or over a saved guide", () => {
    expect(shouldAutoGenerateGuide(view)).toBe(false);
    const data = { guide: null, run: null, currentHeadSha: "head" };
    expect(shouldAutoGenerateGuide({ ...view, data, canWrite: false })).toBe(false);
    expect(shouldAutoGenerateGuide({ ...view, data, running: true })).toBe(false);
    expect(shouldAutoGenerateGuide({ ...view, data: { ...data, guide } })).toBe(false);
  });
});
