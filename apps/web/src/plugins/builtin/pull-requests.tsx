import { lazy } from "react";

import type { ClientPluginSdk } from "../PluginHost";
import { declareBuiltinFeatures } from "../features";

declareBuiltinFeatures("t3.pull-requests", [
  "pull-request.page",
  "pull-request.detail",
  "pull-request.thread",
]);

export function activate(sdk: ClientPluginSdk) {
  sdk.register([
    {
      slot: "pull-request.page",
      order: -1000,
      component: lazy(() =>
        import("~/components/pullRequest/PullRequestsPage").then((module) => ({
          default: module.PullRequestsRouteView,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "pull-request.detail",
      order: -1000,
      component: lazy(() =>
        import("~/components/pullRequest/PullRequestDetailPanel").then((module) => ({
          default: module.BuiltinPullRequestDetailPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "pull-request.thread",
      order: -1000,
      component: lazy(() =>
        import("~/components/pullRequest/ThreadPullRequestsPanel").then((module) => ({
          default: module.BuiltinThreadPullRequestsPanel,
        })),
      ),
    },
  ]);
}
