import { createFileRoute, redirect } from "@tanstack/react-router";

import { ReviewSweepView } from "../components/reviewSweep/ReviewSweepView";

export const Route = createFileRoute("/review-sweep")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ReviewSweepView,
});
