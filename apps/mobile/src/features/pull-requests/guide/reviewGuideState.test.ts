import { ProviderInstanceId, type PullRequestReviewGuideResult } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { guideNoticeState } from "./reviewGuideState";

const headSha = "head";
const timestamp = "2026-10-01T00:00:00.000Z";
const running = { _tag: "Running", headSha, startedAt: timestamp } as const;
const savedGuide = {
  headSha,
  generatedAt: timestamp,
  modelSelection: { instanceId: ProviderInstanceId.make("test"), model: "test" },
  stops: [],
};
const cases = [
  { label: "a first write was running", guide: null, run: running },
  { label: "a rewrite was running", guide: savedGuide, run: running },
  {
    label: "a previous write failed",
    guide: savedGuide,
    run: {
      _tag: "Failed",
      headSha,
      failedAt: timestamp,
      detail: "The model rejected the request.",
    },
  },
] satisfies Array<Pick<PullRequestReviewGuideResult, "guide" | "run"> & { label: string }>;

it.each(cases)("offers to refresh after access is lost when $label", ({ guide, run }) => {
  const error = "GitLab could not find this merge request.";
  expect(
    guideNoticeState({
      data: { guide, run, currentHeadSha: headSha },
      isPending: false,
      running: run._tag === "Running",
      startError: null,
      error,
    }),
  ).toMatchObject({ kind: "unavailable", description: error });
});
