import * as DelegatedLaunchAdmission from "./DelegatedLaunchAdmission.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";

export const layer = Layer.mergeAll(
  Layer.succeed(DelegatedLaunchAdmission.DelegatedLaunchAdmission, {
    check: (selection) => Effect.succeed({ status: "ready", selection, domains: [] }),
    markStarted: () => Effect.void,
    recover: () => Effect.succeed(false),
    recoverBoundLaunch: () => Effect.succeed(false),
    prepare: () => Effect.succeed(true),
  }),
  Layer.mock(GitWorkflow.GitWorkflowService)({
    pruneWorktrees: () => Effect.void,
    createWorktree: () => Effect.succeed({} as never),
  }),
  Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeed(Option.none()),
  }),
);
