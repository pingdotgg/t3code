import { describe, expect, it } from "vite-plus/test";
import {
  IsoDateTime,
  ProviderInstanceId,
  type PullRequestReviewGuideResult,
} from "@t3tools/contracts";
import { guideNoticeState, reviewGuideState } from "./reviewGuideState";

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
};

describe("guide notice transitions", () => {
  it("does not flash an empty guide before the first response", () => {
    expect(guideNoticeState({ ...view, isPending: true }).kind).toBe("loading");
    expect(
      guideNoticeState({ ...view, data: { guide: null, run: null, currentHeadSha: "head" } }).kind,
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
