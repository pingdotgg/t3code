import { defineIssueTrackerDriver } from "@t3tools/issue-tracker-core/server/driver";
import { KIND, make } from "./JiraIssueTracker.ts";

export const driver = defineIssueTrackerDriver({ kind: KIND, make });
