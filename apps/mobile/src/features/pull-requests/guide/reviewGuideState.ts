import type { PullRequestReviewGuideResult } from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../../i18n/messages";

export function reviewGuideState(data: PullRequestReviewGuideResult | null) {
  const guide = data?.guide ?? null;
  return {
    guide,
    running: data?.run?._tag === "Running",
    stale: guide !== null && data?.currentHeadSha != null && guide.headSha !== data.currentHeadSha,
    failure:
      data?.run?._tag === "Failed" && data.run.headSha === data.currentHeadSha
        ? data.run.detail
        : null,
  };
}

/** The generating notice and auto-start effect must agree on failures from older heads. */
export function shouldAutoGenerateGuide(state: {
  readonly data: PullRequestReviewGuideResult | null;
  readonly running: boolean;
  readonly canWrite: boolean;
}) {
  const { guide, failure } = reviewGuideState(state.data);
  return state.data !== null && !guide && !state.running && state.canWrite && failure === null;
}

/** A pending refresh must not hide cached content, or a new run reveal an old failure. */
export function guideNoticeState(
  state: {
    readonly data: PullRequestReviewGuideResult | null;
    readonly isPending: boolean;
    readonly running: boolean;
    readonly startError: string | null;
    readonly error: string | null;
    readonly canWrite: boolean;
  },
  resolve: MessageResolver = m,
) {
  const { guide, stale, failure } = reviewGuideState(state.data);
  if (state.running) {
    return {
      kind: "writing" as const,
      title: resolve(msg("Rewriting guide")),
      description: guide
        ? resolve(msg("You can keep reading this guide while the agent writes the update."))
        : resolve(
            msg(
              "An agent is reading the change and writing the tour. You can leave and come back when it’s ready.",
            ),
          ),
      action: guide ? resolve(msg("Rewriting…")) : resolve(msg("Writing guide…")),
    };
  }
  const error = state.startError ?? failure;
  if (error) {
    return {
      kind: "failed" as const,
      title: resolve(msg("Could not write guide")),
      description: error,
      action: resolve(msg("Try again")),
    };
  }
  if (state.error) {
    return {
      kind: "unavailable" as const,
      title: resolve(msg("Could not refresh guide")),
      description: state.error,
      action: resolve(msg("Try again")),
    };
  }
  if (!state.data) {
    return {
      kind: "loading" as const,
      title: resolve(msg("Review guide")),
      description: resolve(msg("Checking for a saved guide…")),
      action: resolve(msg("Loading guide…")),
    };
  }
  if (stale) {
    return {
      kind: "stale" as const,
      title: resolve(msg("New changes since this guide")),
      description: resolve(
        msg("You can read the previous guide, or rewrite it for the latest changes."),
      ),
      action: resolve(msg("Rewrite guide")),
    };
  }
  // The screen starts the writer automatically; do not offer a manual action between
  // the initial empty response and the generation effect committing its busy state.
  if (shouldAutoGenerateGuide(state)) {
    return {
      kind: "writing" as const,
      title: resolve(msg("Generating guide")),
      description: resolve(msg("Explore the files while the guide is written.")),
      action: resolve(msg("Writing guide…")),
    };
  }
  return {
    kind: guide ? ("ready" as const) : ("empty" as const),
    title: resolve(msg("Review guide")),
    description: resolve(
      msg("Get a tour of the change, with code excerpts and notes on what needs a closer look."),
    ),
    action: resolve(msg("Write guide")),
  };
}
