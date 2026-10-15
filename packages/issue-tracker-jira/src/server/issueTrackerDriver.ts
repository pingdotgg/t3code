import * as Effect from "effect/Effect";
import { defineIssueTrackerDriver } from "@t3tools/issue-tracker-core/server/driver";

import * as JiraApi from "./JiraApi.ts";
import * as JiraIssueTracker from "./JiraIssueTracker.ts";

export const driver = defineIssueTrackerDriver({
  kind: JiraApi.KIND,
  make: JiraIssueTracker.make.pipe(Effect.provideServiceEffect(JiraApi.JiraApi, JiraApi.make)),
});
