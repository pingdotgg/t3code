import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import {
  GENERIC_API_CATALOGUE,
  PRS_WRITE,
  PRS_WRITE_API,
  VCS_ACTIONS,
  VCS_ACTIONS_API,
  VCS_HANDOFF,
  VCS_MUTATE,
  VCS_READ,
  prsWriteApi,
  prsWriteApiV1,
  vcsActionsApi,
} from "../dist/catalogue.js";
import { bindApi } from "../dist/capabilities.js";
import { requireApi } from "../dist/authoring.js";

const methodsOf = (definition) =>
  Object.fromEntries((definition.methods ?? []).map((m) => [m.name, m]));
const streamsOf = (definition) =>
  Object.fromEntries((definition.streams ?? []).map((s) => [s.name, s]));

const vcsMethods = methodsOf(VCS_ACTIONS_API);
const vcsStreams = streamsOf(VCS_ACTIONS_API);
const prsMethods = methodsOf(PRS_WRITE_API);

NodeTest.test("t3.vcs/actions is a 1.1.0 catalogue entry registered once", () => {
  NodeAssert.equal(VCS_ACTIONS_API.id, VCS_ACTIONS);
  NodeAssert.equal(VCS_ACTIONS_API.version, "1.1.0");
  NodeAssert.equal(vcsActionsApi.definition, VCS_ACTIONS_API);
  NodeAssert.deepEqual(
    GENERIC_API_CATALOGUE.filter((d) => d.id === VCS_ACTIONS),
    [VCS_ACTIONS_API],
  );
});

NodeTest.test("t3.prs/write 1.1.0 retains its frozen 1.0.0 catalogue entry", () => {
  NodeAssert.equal(PRS_WRITE_API.id, PRS_WRITE);
  NodeAssert.equal(PRS_WRITE_API.version, "1.1.0");
  NodeAssert.equal(prsWriteApi.definition, PRS_WRITE_API);
  NodeAssert.equal(
    prsWriteApi.additions.some((addition) => addition.output === "operations"),
    false,
  );
  NodeAssert.equal(
    prsMethods.setFilesViewed.inputSchema.properties.files.items.properties.path.maxLength,
    4096,
  );
  NodeAssert.deepEqual(
    GENERIC_API_CATALOGUE.filter((d) => d.id === PRS_WRITE),
    [PRS_WRITE_API, prsWriteApiV1.definition],
  );
});

NodeTest.test(
  "viewed writes negotiate the new minor while old writes keep their baseline",
  async () => {
    NodeAssert.equal(
      prsWriteApiV1.definition.methods.some((method) => method.name === "setFilesViewed"),
      false,
    );
    NodeAssert.deepEqual(requireApi(prsWriteApi), { id: PRS_WRITE, versionRange: "^1.0.0" });
    const calls = [];
    const client = {
      invokeApi: async (request) => {
        calls.push(request);
        return {};
      },
    };
    const context = { resource: { namespace: "test", id: "test", projectId: "p" }, client: "web" };
    const input = { repository: "o/r", number: 3, files: [{ path: "a.ts", viewed: true }] };
    const signal = new AbortController().signal;
    await NodeAssert.rejects(
      bindApi(prsWriteApi, client, context).invoke("setFilesViewed", input, signal),
      /needs \^1\.1\.0/,
    );
    NodeAssert.equal(calls.length, 0);
    await bindApi(prsWriteApi, client, context, "^1.1.0").invoke("setFilesViewed", input, signal);
    NodeAssert.equal(calls[0].versionRange, "^1.1.0");
    NodeAssert.deepEqual(calls[0].input, input);
  },
);

NodeTest.test("vcs mutations ride t3.vcs/mutate; progress rides t3.vcs/read", () => {
  NodeAssert.deepEqual(Object.keys(vcsMethods).sort(), [
    "getCapabilities",
    "handoffPullRequest",
    "preparePullRequestThread",
    "publishRepository",
    "resolvePullRequest",
    "run",
  ]);
  for (const [name, method] of Object.entries(vcsMethods)) {
    NodeAssert.equal(method.inputSchema.additionalProperties, false, name);
    NodeAssert.deepEqual(
      method.requiredGrants,
      name === "getCapabilities"
        ? [VCS_READ]
        : name === "handoffPullRequest"
          ? [VCS_MUTATE, VCS_HANDOFF]
          : [VCS_MUTATE],
      name,
    );
  }
  // The composite's pr phase and publishRepository caller-chain-check
  // t3.prs/write inside the adapter — a static grant list cannot express
  // "grant follows the input", so nothing here may declare it.
  for (const method of Object.values(vcsMethods)) {
    NodeAssert.ok(!method.requiredGrants.includes(PRS_WRITE), method.name);
  }
  NodeAssert.deepEqual(Object.keys(vcsStreams), ["actionProgress"]);
  NodeAssert.deepEqual(vcsStreams.actionProgress.requiredGrants, [VCS_READ]);
  NodeAssert.equal(vcsStreams.actionProgress.inputSchema.additionalProperties, false);
});

NodeTest.test("run returns an action id; progress carries the T2 event family", () => {
  const output = vcsMethods.run.outputSchema;
  NodeAssert.deepEqual(output.required, ["actionId"]);
  NodeAssert.equal(output.properties.actionId.maxLength, 128);

  const kinds = vcsStreams.actionProgress.eventSchema.oneOf.map(
    (variant) => variant.properties.kind.const,
  );
  NodeAssert.deepEqual(kinds.sort(), [
    "action_failed",
    "action_finished",
    "action_started",
    "closed",
    "hook_finished",
    "hook_output",
    "hook_started",
    "phase_started",
  ]);
  const closed = vcsStreams.actionProgress.eventSchema.oneOf.find(
    (variant) => variant.properties.kind.const === "closed",
  );
  // overflow = bounded-queue cut; authorization-revoked = the detached
  // post-service recheck found authority/grant gone after phases ran.
  NodeAssert.deepEqual(closed.properties.reason.enum, ["overflow", "authorization-revoked"]);
});

NodeTest.test("no clone or standalone prs.create surface exists on either contract", () => {
  NodeAssert.equal("cloneRepository" in vcsMethods, false);
  NodeAssert.equal("cloneRepository" in vcsStreams, false);
  NodeAssert.equal("create" in prsMethods, false);
});

NodeTest.test("every prs write op is write-effected and rides t3.prs/write alone", () => {
  NodeAssert.deepEqual(Object.keys(prsMethods).sort(), [
    "comment",
    "getCapabilities",
    "replyToThread",
    "requestReviewers",
    "runAction",
    "setFilesViewed",
    "setLabels",
    "setReaction",
    "setThreadResolution",
    "submitReview",
    "update",
    "updateComment",
  ]);
  for (const [name, method] of Object.entries(prsMethods)) {
    NodeAssert.equal(method.effect, name === "getCapabilities" ? "read" : "write", name);
    NodeAssert.deepEqual(method.requiredGrants, [PRS_WRITE], name);
    NodeAssert.equal(method.inputSchema.additionalProperties, false, name);
  }
});

NodeTest.test("prs write inputs carry the ref without letting it widen scope", () => {
  for (const [name, method] of Object.entries(prsMethods)) {
    if (name === "getCapabilities") continue;
    const properties = method.inputSchema.properties;
    NodeAssert.ok(method.inputSchema.required.includes("repository"), name);
    NodeAssert.ok(method.inputSchema.required.includes("number"), name);
    NodeAssert.equal("projectId" in properties, false, name);
    NodeAssert.equal("projectIds" in properties, false, name);
  }
  const action = prsMethods.runAction.inputSchema;
  NodeAssert.deepEqual(action.properties.action.enum, [
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
    "revert",
    "approve-workflows",
  ]);
  NodeAssert.deepEqual(action.properties.mergeMethod.enum, ["merge", "squash", "rebase"]);
  NodeAssert.deepEqual(action.properties.updateMethod.enum, ["merge", "rebase"]);
});

NodeTest.test("prs write capabilities disclose declared host support per operation", () => {
  const output = prsMethods.getCapabilities.outputSchema;
  for (const key of [
    "hosted",
    "reason",
    "detail",
    "operations",
    "actions",
    "mergeMethods",
    "updateMethods",
    "verdicts",
  ]) {
    NodeAssert.ok(output.required.includes(key), key);
  }
  const operations = output.properties.operations;
  for (const key of [
    "prs.runAction",
    "prs.update",
    "prs.comment",
    "prs.updateComment",
    "prs.submitReview",
    "prs.replyToThread",
    "prs.setThreadResolution",
    "prs.setReaction",
    "prs.requestReviewers",
    "prs.setLabels",
  ]) {
    NodeAssert.equal(operations.properties[key].type, "boolean", key);
  }
});
