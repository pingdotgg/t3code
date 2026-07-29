import { assert, it } from "@effect/vitest";
import * as NodeURL from "node:url";

import {
  findActiveWorkflowViolations,
  findForkWorkflowPolicyViolations,
} from "./fork-workflow-policy.ts";

const repositoryRoot = NodeURL.fileURLToPath(new URL("../", import.meta.url));

it("keeps fork workflows on available runners and outside upstream production accounts", () => {
  assert.deepEqual(findForkWorkflowPolicyViolations(repositoryRoot), []);
});

it("allows a standard hosted runner and the built-in GitHub token", () => {
  const workflow = [
    "jobs:",
    "  check:",
    "    runs-on: ubuntu-24.04",
    "    token: secrets.GITHUB_TOKEN",
  ].join("\n");

  assert.deepEqual(findActiveWorkflowViolations("ci.yml", workflow), []);
});

it("rejects unapproved runners, secrets, and repository variables", () => {
  const workflow = [
    "jobs:",
    "  publish:",
    "    runs-on: blacksmith-8vcpu-ubuntu-2404",
    "    token: secrets.EXPO_TOKEN",
    "    project: vars.EXPO_PROJECT_ID",
  ].join("\n");

  assert.deepEqual(findActiveWorkflowViolations("publish.yml", workflow), [
    "publish.yml: runner 'blacksmith-8vcpu-ubuntu-2404' is not approved for this fork",
    "publish.yml: credential 'secrets.EXPO_TOKEN' has no approved fork owner",
    "publish.yml: credential 'vars.EXPO_PROJECT_ID' has no approved fork owner",
  ]);
});
