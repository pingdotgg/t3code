import { describe, expect, it } from "vite-plus/test";
import {
  IsoDateTime,
  ProviderInstanceId,
  type PullRequestReviewGuideResult,
} from "@t3tools/contracts";
import { guideNoticeState, reviewGuideState, shouldAutoGenerateGuide } from "./reviewGuideState";

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
  it("does not label an unknown head stale", () => {
    expect(reviewGuideState({ guide, currentHeadSha: null, run: null }).stale).toBe(false);
  });
  it("shows only failures for the current head", () => {
    const run = {
      _tag: "Failed" as const,
      headSha: "old-head",
      failedAt: guide.generatedAt,
      detail: "The writer disconnected.",
    };
    expect(reviewGuideState({ guide: null, currentHeadSha: "old-head", run }).failure).toBe(
      run.detail,
    );
    expect(reviewGuideState({ guide: null, currentHeadSha: "new-head", run }).failure).toBeNull();
  });
  it("starts empty without claiming a job is running", () => {
    expect(reviewGuideState(null)).toEqual({
      guide: null,
      stale: false,
      running: false,
      failure: null,
    });
  });
});

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

  it("keeps cached guides visible while refreshing", () => {
    expect(
      guideNoticeState({
        ...view,
        isPending: true,
        data: { guide, run: null, currentHeadSha: guide.headSha },
      }).kind,
    ).toBe("ready");
  });

  it("hides the previous failure as soon as a retry starts", () => {
    const data = {
      guide: null,
      currentHeadSha: "head",
      run: {
        _tag: "Failed" as const,
        headSha: "head",
        failedAt: guide.generatedAt,
        detail: "Writer disconnected",
      },
    };
    expect(guideNoticeState({ ...view, data }).kind).toBe("failed");
    expect(guideNoticeState({ ...view, data, running: true }).kind).toBe("writing");
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

  it("keeps a stale guide readable through rewriting and completion", () => {
    const data = { guide, currentHeadSha: "head", run: null };
    expect(guideNoticeState({ ...view, data }).kind).toBe("stale");
    expect(guideNoticeState({ ...view, data, running: true }).kind).toBe("writing");
    expect(
      guideNoticeState({ ...view, data: { ...data, guide: { ...guide, headSha: "head" } } }).kind,
    ).toBe("ready");
  });
});

it("distinguishes a failed read from a failed writer", () => {
  expect(guideNoticeState({ ...view, error: "Connection lost" }).kind).toBe("unavailable");
});
