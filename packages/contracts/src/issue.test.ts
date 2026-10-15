import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AuthOrchestrationReadScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS, WsIssuesRpcGroup } from "./rpc.ts";
import { ProjectId } from "./baseSchemas.ts";
import {
  IssueActor,
  IssueCommentsPageInput,
  IssueCapabilities,
  IssueCandidates,
  IssueCreateInput,
  IssueCreateResult,
  IssueDetail,
  IssueLinkedPullRequest,
  IssueResolveUrlInput,
  IssueResolvedUrl,
  IssueSummary,
  IssueTemplate,
  IssueTemplatesInput,
  IssueTrackerKind,
  IssueTrackerProjectBinding,
  StandaloneIssueTrackerDescriptor,
  ThreadIssueLink,
  threadIssueKeyOf,
  issueScopeKeyOf,
} from "./issue.ts";

const decodeDescriptor = Schema.decodeEffect(StandaloneIssueTrackerDescriptor);
const decodeActor = Schema.decodeEffect(IssueActor);
const decodeCreate = Schema.decodeEffect(IssueCreateInput);
const decodeCreated = Schema.decodeEffect(IssueCreateResult);
const decodeBinding = Schema.decodeEffect(IssueTrackerProjectBinding);
const decodeTemplateInput = Schema.decodeUnknownSync(IssueTemplatesInput);
const decodeTemplateRpc = Schema.decodeUnknownSync(
  WsIssuesRpcGroup.requests.get(WS_METHODS.issuesTemplates)!.payloadSchema,
);
const decodeTemplate = Schema.decodeUnknownSync(IssueTemplate);

it.each([
  { tracker: "linear", key: "eng-7", canonical: "ENG-7", equal: true },
  { tracker: "jira", key: "ops-7", canonical: "OPS-7", equal: true },
  { tracker: "custom-tracker", key: "eng-7", canonical: "ENG-7", equal: false },
  { tracker: "github", key: "7", canonical: "7", equal: true },
  { tracker: "gitlab", key: "7", canonical: "07", equal: false },
])("matches $tracker keys with their native case rules", ({ tracker, key, canonical, equal }) => {
  const identity = { tracker, host: "example.com", scope: "workspace/team", key: canonical };
  const saved = { tracker, host: " Example.COM ", scope: " Workspace/TEAM ", key: ` ${key} ` };
  expect(threadIssueKeyOf(saved) === threadIssueKeyOf(identity)).toBe(equal);
  expect(threadIssueKeyOf(identity)).not.toBe(
    threadIssueKeyOf({ ...identity, tracker: tracker.toUpperCase() }),
  );
});

it.each([
  { tracker: "forgejo", scope: " Mount/Acme/Web ", expected: "Mount/acme/web" },
  { tracker: "forgejo", scope: " mount/Acme/Web ", expected: "mount/acme/web" },
  { tracker: "forgejo", scope: " Mount/Nested/Acme/Web ", expected: "Mount/Nested/acme/web" },
  { tracker: "forgejo", scope: " Acme/Web ", expected: "acme/web" },
  { tracker: "github", scope: " Mount/Acme/Web ", expected: "mount/acme/web" },
  { tracker: "linear", scope: " Workspace/TEAM ", expected: "workspace/team" },
  { tracker: "jira", scope: " Workspace/TEAM ", expected: "workspace/team" },
  { tracker: "custom-tracker", scope: " Mount/Acme/Web ", expected: "mount/acme/web" },
])("normalizes $tracker scope $scope", ({ tracker, scope, expected }) => {
  expect(issueScopeKeyOf({ tracker, scope })).toBe(expected);
});

it("keeps Forgejo mount case distinct while matching repository case aliases", () => {
  const issue = { tracker: "forgejo", host: "forgejo.test", scope: "Mount/Acme/Web", key: "42" };
  expect(threadIssueKeyOf(issue)).toBe(
    threadIssueKeyOf({ ...issue, host: " Forgejo.TEST ", scope: " Mount/acme/web " }),
  );
  expect(threadIssueKeyOf(issue)).not.toBe(threadIssueKeyOf({ ...issue, scope: "mount/Acme/Web" }));
});

it("carries template selection through the existing RPC and retains required inline bodies", () => {
  const input = {
    projectId: ProjectId.make("project-1"),
    tracker: IssueTrackerKind.make("gitlab"),
    host: "gitlab.com",
    scope: "acme/web",
  };
  for (const flags of [
    {},
    { metadataOnly: false },
    { metadataOnly: true },
    { templateKey: "Bug" },
    { metadataOnly: false, templateKey: "Bug" },
  ]) {
    const request = { ...input, ...flags };
    expect(decodeTemplateInput(request)).toEqual(request);
    expect(decodeTemplateRpc(request)).toEqual(request);
  }
  const template = {
    key: "Bug",
    name: "Bug",
    about: "",
    title: "",
    body: "",
    labels: [],
    assignees: [],
  };
  expect(decodeTemplate(template)).toEqual(template);
  for (const contentDeferred of [false, true]) {
    expect(decodeTemplate({ ...template, contentDeferred })).toEqual({
      ...template,
      contentDeferred,
    });
  }
  expect(() => decodeTemplate({ ...template, body: undefined, contentDeferred: true })).toThrow();
  expect(() => decodeTemplateInput({ ...input, templateKey: " " })).toThrow();
});

it("preserves native label IDs in candidates and accepts older labels", () => {
  const candidates = {
    labels: [
      { name: "Bug", color: null, description: null, id: "label-123" },
      { name: "Old", color: null, description: null },
    ],
    assignees: [],
    truncated: false,
  };
  assert.deepEqual(Schema.decodeSync(IssueCandidates)(candidates), candidates);
});

it("accepts older reaction capabilities and preserves native comment limits", () => {
  const decode = Schema.decodeUnknownSync(IssueCapabilities);
  const capabilities = {
    create: true,
    edit: true,
    comment: true,
    labels: true,
    assignees: true,
    reactions: true,
    templates: false,
    linkedPullRequests: true,
    events: true,
    search: true,
    states: [],
    closeReasons: [],
  };
  expect(decode(capabilities)).toEqual(capabilities);
  const native = {
    ...capabilities,
    reactions: false,
    commentReactions: true,
    reactionContents: ["thumbs-up", "thumbs-down", "heart", "hooray", "laugh", "confused"],
  };
  expect(decode(native)).toEqual(native);
  expect(() => decode({ ...native, reactionContents: ["like"] })).toThrow();
  expect(() => decode({ ...native, reactionContents: Array(9).fill("heart") })).toThrow();
});

it("keeps unknown comment totals nullable and known totals non-negative integers", () => {
  const decode = Schema.decodeUnknownSync(IssueSummary.fields.commentCount);
  expect(decode(null)).toBeNull();
  expect(decode(0)).toBe(0);
  expect(decode(101)).toBe(101);
  expect(() => decode(-1)).toThrow();
  expect(() => decode(1.5)).toThrow();
  expect(Schema.toJsonSchemaDocument(IssueSummary.fields.commentCount).schema).toMatchObject({
    anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
  });
});

it("accepts unknown linked pull request states while preserving known states", () => {
  const decode = Schema.decodeUnknownSync(IssueLinkedPullRequest.fields.state);
  for (const state of [null, "open", "closed", "merged"]) {
    expect(decode(state)).toBe(state);
  }
  expect(() => decode("unknown")).toThrow();
});

it.effect("decodes a tracker that needs a site and several credential fields", () =>
  Effect.gen(function* () {
    const descriptor = {
      tracker: IssueTrackerKind.make("jira"),
      displayName: "Jira",
      host: null,
      scopeNoun: "project",
      credential: {
        label: "API token",
        helpUrl: null,
        fields: [
          { key: "site", label: "Site", secret: false },
          { key: "email", label: "Email", secret: false },
          { key: "token", label: "API token", secret: true },
        ],
      },
    };
    assert.deepEqual(yield* decodeDescriptor(descriptor), descriptor);
  }),
);

it.effect("keeps native actor identifiers distinct from their visible login", () =>
  Effect.gen(function* () {
    const actor = { login: "Alex", id: "account-123", name: null, avatarUrl: null };
    assert.deepEqual(yield* decodeActor(actor), actor);
  }),
);

it.effect("preserves the selected native issue type on create", () =>
  Effect.gen(function* () {
    const input = {
      projectId: ProjectId.make("project-1"),
      tracker: IssueTrackerKind.make("jira"),
      scope: "ENG",
      title: "Fix",
      body: "",
      labels: [],
      assignees: [],
      issueType: "10001",
    };
    assert.deepEqual(yield* decodeCreate(input), input);
  }),
);

it.effect("retains a binding's real site and accepts older fixed-host bindings", () =>
  Effect.gen(function* () {
    const binding = {
      tracker: IssueTrackerKind.make("jira"),
      scope: "ENG",
      host: "example.atlassian.net",
    };
    assert.deepEqual(yield* decodeBinding(binding), binding);
    const old = { tracker: IssueTrackerKind.make("linear"), scope: "ENG" };
    assert.deepEqual(yield* decodeBinding(old), old);
  }),
);

it.effect("preserves a created issue and warnings about native fields that were skipped", () =>
  Effect.gen(function* () {
    const created = {
      key: "42",
      displayKey: "#42",
      url: "https://forgejo.example/acme/web/issues/42",
      warnings: ["The issue was created, but the host did not apply the selected labels."],
    };
    assert.deepEqual(yield* decodeCreated(created), created);
  }),
);

it("keeps URL resolution direct and protected by the read grant", () => {
  const input = { url: "https://github.com/acme/web/issues/1", projectId: ProjectId.make("web") };
  expect(Schema.decodeSync(IssueResolveUrlInput)(input)).toEqual(input);
  const result = {
    projectId: ProjectId.make("web"),
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "acme/web",
    key: "1",
    writable: true,
  };
  expect(Schema.decodeSync(IssueResolvedUrl)(result)).toEqual(result);
  expect(clientRpcRequiredScopes(WS_METHODS.issuesResolveUrl, input)).toEqual([
    AuthOrchestrationReadScope,
  ]);
});

it("preserves optional comment-page viewer context while accepting older clients", () => {
  const decode = Schema.decodeUnknownSync(IssueCommentsPageInput);
  const input = {
    projectId: "project",
    tracker: "linear",
    host: "linear.app",
    scope: "acme/ENG",
    key: "ENG-7",
    cursor: "older",
  };
  expect(decode(input)).toEqual(input);
  expect(decode({ ...input, viewer: "native-viewer" })).toEqual({
    ...input,
    viewer: "native-viewer",
  });
  expect(() => decode({ ...input, viewer: " " })).toThrow();
});

it("accepts saved issue links without generation IDs and preserves new IDs", () => {
  const decode = Schema.decodeUnknownSync(ThreadIssueLink);
  const link = {
    projectId: "project",
    tracker: "github",
    host: "github.com",
    scope: "acme/web",
    key: "7",
    url: "https://github.com/acme/web/issues/7",
    source: "agent",
    linkedAt: "2026-10-14T00:00:00.000Z",
    snapshot: null,
  };
  expect(decode(link)).toEqual(link);
  expect(decode({ ...link, linkId: "link-command" })).toEqual({
    ...link,
    linkId: "link-command",
  });
});

it("accepts older issue details and preserves body safety and native states", () => {
  const decode = Schema.decodeUnknownSync(
    Schema.Struct({
      bodyEditable: IssueDetail.fields.bodyEditable,
      states: IssueDetail.fields.states,
    }),
  );
  expect(decode({})).toEqual({});
  for (const bodyEditable of [true, false]) {
    const metadata = { bodyEditable, states: [{ name: "Ready", category: "open" }] };
    expect(decode(metadata)).toEqual(metadata);
  }
  expect(() => decode({ bodyEditable: "false" })).toThrow();
  expect(() => decode({ states: [{ name: "Ready", category: "unknown" }] })).toThrow();
});
