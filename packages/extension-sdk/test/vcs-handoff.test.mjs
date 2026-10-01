import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
// Namespace imports: before the contract exists each test fails on its own assertion.
import * as Catalogue from "../dist/catalogue.js";
import * as ClientProviders from "../dist/clientProviders.js";
import { ApiVersionError, bindApi } from "../dist/capabilities.js";

const {
  COMPOSER_CONTEXT_API,
  MESSAGES_ENRICHMENT_API,
  VCS_ACTIONS_API,
  VCS_HANDOFF,
  VCS_MUTATE,
  vcsActionsApi,
} = Catalogue;
const { CLIENT_PR_HANDOFF_API, CLIENT_PR_HANDOFF_TASKS, CLIENT_PROVIDER_APIS } = ClientProviders;

const methodsOf = (definition) =>
  Object.fromEntries((definition.methods ?? []).map((m) => [m.name, m]));
/** Every property name a schema can carry, at any depth. */
const propertyNames = (schema) => {
  const names = [];
  const walk = (node) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    for (const [key, value] of Object.entries(node.properties ?? {})) {
      names.push(key);
      walk(value);
    }
    for (const key of ["items", "oneOf", "anyOf"]) walk(node[key]);
  };
  walk(schema);
  return names;
};
const handoff = methodsOf(VCS_ACTIONS_API).handoffPullRequest ?? {};

NodeTest.test(
  "handoffPullRequest is a 1.1.0 addition existing consumers never bind by default",
  () => {
    NodeAssert.equal(VCS_ACTIONS_API.version, "1.1.0");
    NodeAssert.equal(vcsActionsApi.baseline, "1.0.0");
    NodeAssert.deepEqual(vcsActionsApi.additions, [
      { version: "1.1.0", method: "handoffPullRequest" },
    ]);
  },
);

NodeTest.test("the handoff needs its own grant on top of the checkout's", () => {
  NodeAssert.equal(VCS_HANDOFF, "t3.vcs/handoff");
  NodeAssert.equal(handoff.effect, "write");
  NodeAssert.deepEqual(handoff.requiredGrants, [VCS_MUTATE, VCS_HANDOFF]);
  // No other method rides the handoff grant.
  for (const method of VCS_ACTIONS_API.methods ?? []) {
    if (method.name !== "handoffPullRequest")
      NodeAssert.ok(!method.requiredGrants.includes(VCS_HANDOFF), method.name);
  }
});

NodeTest.test("the input is a pull-request identity and a closed task kind, nothing else", () => {
  const input = handoff.inputSchema;
  NodeAssert.ok(input !== undefined, "handoffPullRequest is declared");
  NodeAssert.equal(input.additionalProperties, false);
  NodeAssert.deepEqual(input.required, ["reference", "task"]);
  NodeAssert.deepEqual(Object.keys(input.properties).sort(), ["mode", "reference", "task"]);
  NodeAssert.deepEqual(input.properties.task, { enum: ["checkout", "resolve-conflicts"] });
  // Native's two checkout menu entries; absent reads as the worktree, native's default.
  NodeAssert.deepEqual(input.properties.mode, { enum: ["worktree", "local"] });
  NodeAssert.deepEqual(CLIENT_PR_HANDOFF_TASKS, ["checkout", "resolve-conflicts"]);
  NodeAssert.equal(input.properties.reference.maxLength, 2048);
});

NodeTest.test("no receipt hands prompt text back or claims a send", () => {
  NodeAssert.ok(handoff.outputSchema !== undefined, "handoffPullRequest is declared");
  const names = propertyNames(handoff.outputSchema);
  NodeAssert.ok(names.length > 0);
  for (const name of names) NodeAssert.ok(!/prompt|text|message|sent|send/i.test(name), name);
  NodeAssert.deepEqual(
    handoff.outputSchema.oneOf.map((variant) => variant.properties.status.const).sort(),
    ["drafted", "failed", "ready"],
  );
});

NodeTest.test("the client seam carries only host-resolved fields and never a send", () => {
  NodeAssert.ok(CLIENT_PR_HANDOFF_API !== undefined, "t3.client/pr-handoff is defined");
  NodeAssert.equal(CLIENT_PROVIDER_APIS.get("t3.client/pr-handoff"), CLIENT_PR_HANDOFF_API);
  NodeAssert.deepEqual(
    (CLIENT_PR_HANDOFF_API.methods ?? []).map((method) => method.name),
    ["start"],
  );
  const [start] = CLIENT_PR_HANDOFF_API.methods;
  NodeAssert.equal(start.inputSchema.additionalProperties, false);
  NodeAssert.deepEqual(start.inputSchema.required, ["target", "task", "mode", "pullRequest"]);
  NodeAssert.deepEqual(start.inputSchema.properties.mode, { enum: ["worktree", "local"] });
  NodeAssert.deepEqual(Object.keys(start.inputSchema.properties).sort(), [
    "mode",
    "pullRequest",
    "target",
    "task",
  ]);
  const pullRequest = start.inputSchema.properties.pullRequest;
  NodeAssert.equal(pullRequest.additionalProperties, false);
  NodeAssert.deepEqual(Object.keys(pullRequest.properties).sort(), [
    "baseBranch",
    "headBranch",
    "number",
    "url",
  ]);
  NodeAssert.deepEqual(start.outputSchema, handoff.outputSchema);
});

NodeTest.test("the composer contracts still expose no send or prompt method", () => {
  for (const definition of [COMPOSER_CONTEXT_API, MESSAGES_ENRICHMENT_API]) {
    for (const method of definition.methods ?? []) {
      NodeAssert.ok(!/send|prompt|handoff/i.test(method.name), method.name);
    }
  }
});

NodeTest.test("a baseline binding refuses the handoff before it reaches the host", async () => {
  const calls = [];
  const client = {
    invokeApi: async (request) => {
      calls.push(request);
      return { status: "drafted" };
    },
  };
  const context = { client: "web", resource: { namespace: "n", id: "i", projectId: "p" } };
  const signal = new AbortController().signal;
  await NodeAssert.rejects(
    bindApi(vcsActionsApi, client, context).invoke(
      "handoffPullRequest",
      { reference: "https://github.com/o/r/pull/1", task: "checkout" },
      signal,
    ),
    ApiVersionError,
  );
  NodeAssert.equal(calls.length, 0);
  await bindApi(vcsActionsApi, client, context, "^1.1.0").invoke(
    "handoffPullRequest",
    { reference: "https://github.com/o/r/pull/1", task: "resolve-conflicts" },
    signal,
  );
  NodeAssert.deepEqual(
    calls.map((call) => [call.id, call.versionRange, call.method]),
    [["t3.vcs/actions", "^1.1.0", "handoffPullRequest"]],
  );
});
