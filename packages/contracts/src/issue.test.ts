import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AuthOrchestrationReadScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS, WsIssuesRpcGroup } from "./rpc.ts";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  IssueActor,
  IssueEvent,
  IssueHistoryInput,
  IssueInputField,
  IssueCandidates,
  IssueFieldValues,
  IssueRichBody,
  IssueViewerPermissions,
  IssueDependenciesPage,
  IssueCandidatesInput,
  IssueCommentsPageInput,
  ThreadIssueLink,
  IssueLabelCandidatesPage,
  IssueState,
  IssuePageInput,
  IssueHierarchyPage,
  IssueTemplate,
  IssueTemplateList,
  IssueTemplatesInput,
  IssueScopeRef,
  IssueCapabilities,
  IssueCreateInput,
  IssueCommentInput,
  IssueEditCommentInput,
  IssueCreateResult,
  IssueDetail,
  IssueLinkedPullRequest,
  IssueResolveUrlInput,
  IssueResolvedUrl,
  IssueSummary,
  IssueTrackerKind,
  issueListCursorKey,
  issueHostKey,
  issueTrackerHostKey,
  threadIssueKeyOf,
  threadIssueKeysEqual,
  threadIssueRefOf,
  IssueTrackerProjectBinding,
  IssueListProjectError,
  IssueTrackerConnectionList,
  IssueTrackerConnectInput,
  IssueTrackerBindProjectInput,
  StandaloneIssueTrackerDescriptor,
} from "./issue.ts";

const decodeHistoryRpc = Schema.decodeUnknownSync(
  WsIssuesRpcGroup.requests.get(WS_METHODS.issuesHistory)!.payloadSchema,
);
const decodeCommentsRpc = Schema.decodeUnknownSync(
  WsIssuesRpcGroup.requests.get(WS_METHODS.issuesComments)!.payloadSchema,
);
const decodeHistoryInput = Schema.decodeUnknownSync(IssueHistoryInput);
const decodeEvent = Schema.decodeUnknownSync(IssueEvent);
const decodeDescriptor = Schema.decodeEffect(StandaloneIssueTrackerDescriptor);
const decodeComments = Schema.decodeUnknownSync(IssueCommentsPageInput);
const decodeThreadLink = Schema.decodeUnknownSync(ThreadIssueLink);
const encodeThreadLink = Schema.encodeUnknownSync(ThreadIssueLink);
const decodeActor = Schema.decodeEffect(IssueActor);
const decodeCreate = Schema.decodeEffect(IssueCreateInput);
const decodeCreated = Schema.decodeEffect(IssueCreateResult);
const decodeBinding = Schema.decodeEffect(IssueTrackerProjectBinding);
const decodeState = Schema.decodeUnknownSync(IssueState);
const decodePage = Schema.decodeUnknownSync(IssuePageInput);
const decodeHierarchy = Schema.decodeUnknownSync(IssueHierarchyPage);
const decodeTemplate = Schema.decodeUnknownSync(IssueTemplate);
const decodeTemplates = Schema.decodeUnknownSync(IssueTemplateList);
const decodeLabelPage = Schema.decodeUnknownSync(IssueLabelCandidatesPage);
const decodeResolveInput = Schema.decodeSync(IssueResolveUrlInput);
const decodeResolved = Schema.decodeSync(IssueResolvedUrl);
const decodeTemplateInput = Schema.decodeSync(IssueTemplatesInput);
const decodeTemplateRpc = Schema.decodeUnknownSync(
  WsIssuesRpcGroup.requests.get(WS_METHODS.issuesTemplates)!.payloadSchema,
);
const decodeScope = Schema.decodeUnknownSync(IssueScopeRef);
const decodeNativeField = Schema.decodeUnknownSync(IssueInputField);
const decodeNativeCandidates = Schema.decodeUnknownSync(IssueCandidates);
const decodeNativeCreate = Schema.decodeUnknownSync(IssueCreateInput);

it("preserves optional native reactions on issue summaries", () => {
  const decode = Schema.decodeUnknownSync(IssueSummary);
  const summary = {
    tracker: "linear",
    host: "linear.app",
    scope: "ENG",
    key: "ENG-7",
    displayKey: "ENG-7",
    title: "Issue",
    url: "https://linear.app/team/issue/ENG-7/issue",
    author: null,
    state: { name: "Open", category: "open" },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: null,
  };
  expect(decode(summary)).toEqual(summary);
  const reactions = [{ content: "thumbs-up", count: 1, actors: [], viewerHasReacted: true }];
  expect(decode({ ...summary, reactions, reactionsTruncated: true })).toEqual({
    ...summary,
    reactions,
    reactionsTruncated: true,
  });
  expect(() => decode({ ...summary, reactions: [{ ...reactions[0], count: 0 }] })).toThrow();
});

it("carries an optional native key through the existing candidates RPC", () => {
  const decodeInput = Schema.decodeSync(IssueCandidatesInput);
  const decode = Schema.decodeUnknownSync(
    WsIssuesRpcGroup.requests.get(WS_METHODS.issuesCandidates)!.payloadSchema,
  );
  const scope = {
    projectId: ProjectId.make("project-1"),
    tracker: IssueTrackerKind.make("jira"),
    host: "jira.example.com",
    scope: "OPS",
  };
  for (const selection of [{}, { key: "OPS-7" }]) {
    const input = { ...scope, ...selection };
    expect(decodeInput(input)).toEqual(input);
    expect(decode(input)).toEqual(input);
  }
  for (const key of ["", "  ", null, 7]) {
    expect(() => decode({ ...scope, key })).toThrow();
  }
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

it("preserves native state IDs and workflow categories with stable open and closed groups", () => {
  const state = {
    category: "open",
    name: "In review",
    id: "native-17",
    workflowCategory: "started",
  };
  expect(decodeState(state)).toEqual(state);
  expect(decodeState({ category: "closed", name: "Done" })).toEqual({
    category: "closed",
    name: "Done",
  });
  expect(() => decodeState({ ...state, workflowCategory: "review" })).toThrow();
});

it("bounds issue continuation requests to 200 rows and preserves hierarchy continuation", () => {
  expect(decodePage({ cursor: "native-next", limit: 200 })).toEqual({
    cursor: "native-next",
    limit: 200,
  });
  for (const limit of [0, 201, 1.5]) expect(() => decodePage({ limit })).toThrow();
  expect(() => decodePage({ cursor: "x".repeat(8193) })).toThrow();
  const page = { parent: null, children: { items: [], nextCursor: "next", truncated: true } };
  expect(decodeHierarchy(page)).toEqual(page);
});

it("keeps structured template fields and contact links beside body templates", () => {
  const template = {
    key: "bug.yml",
    name: "Bug",
    about: "Report a bug",
    title: "",
    body: "",
    labels: [],
    assignees: [],
    fields: [
      { kind: "markdown", value: "Steps" },
      {
        kind: "input",
        id: "version",
        label: "Version",
        description: null,
        required: true,
        placeholder: null,
        value: null,
      },
      {
        kind: "dropdown",
        id: "os",
        label: "OS",
        description: null,
        required: true,
        multiple: false,
        options: ["Linux"],
        defaultValues: ["Linux"],
      },
    ],
  };
  expect(decodeTemplate(template)).toEqual(template);
  const list = {
    templates: [template],
    externalTemplates: [],
    blankIssuesEnabled: false,
    contactLinks: [{ name: "Help", about: "Get help", url: "https://example.com/help" }],
    contributingGuidelinesUrl: "https://example.com/contributing",
  };
  expect(decodeTemplates(list)).toEqual(list);
});

it("carries optional template selection through the existing RPC while retaining inline bodies", () => {
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
  ]) {
    const request = { ...input, ...flags };
    expect(decodeTemplateInput(request)).toEqual(request);
    expect(decodeTemplateRpc(request)).toEqual(request);
    expect(decodeScope(request)).toEqual(input);
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
  expect(decodeTemplate({ ...template, contentDeferred: true })).toEqual({
    ...template,
    contentDeferred: true,
  });
  expect(() => decodeTemplate({ ...template, body: undefined, contentDeferred: true })).toThrow();
  expect(() => decodeTemplateInput({ ...input, templateKey: "" })).toThrow();
});

it("preserves distinct native label IDs when labels have the same name", () => {
  const page = {
    items: [
      { id: "team-label-id", name: "Bug", color: null },
      { id: "workspace-label-id", name: "Bug", color: null, description: "Workspace label" },
      { name: "Help", color: "123456" },
    ],
    nextCursor: null,
  };
  expect(decodeLabelPage(page)).toEqual(page);
});

it("keeps URL resolution direct and protected by the read grant", () => {
  const input = { url: "https://github.com/acme/web/issues/1", projectId: ProjectId.make("web") };
  assert.deepEqual(decodeResolveInput(input), input);
  const result = {
    projectId: ProjectId.make("web"),
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "acme/web",
    key: "1",
    writable: true,
  };
  assert.deepEqual(decodeResolved(result), result);
  assert.deepEqual(clientRpcRequiredScopes(WS_METHODS.issuesResolveUrl, input), [
    AuthOrchestrationReadScope,
  ]);
});

it("preserves optional comment-page viewer context while accepting older clients", () => {
  const input = {
    projectId: "project",
    tracker: "linear",
    host: "linear.app",
    scope: "acme/ENG",
    key: "ENG-7",
    cursor: "older",
  };
  expect(decodeComments(input)).toEqual(input);
  expect(decodeComments({ ...input, viewer: "native-viewer" })).toEqual({
    ...input,
    viewer: "native-viewer",
  });
});

it("accepts saved issue links without generation IDs and preserves new IDs", () => {
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
  expect(decodeThreadLink(link)).toEqual(link);
  expect(decodeThreadLink({ ...link, linkId: "link-command" })).toEqual({
    ...link,
    linkId: "link-command",
  });
});

it.each(["linear", "jira"])("compares %s native issue identifiers without case", (tracker) => {
  const lower = {
    tracker: IssueTrackerKind.make(tracker),
    host: "Example.com",
    scope: "acme/ENG",
    key: "eng-7",
  };
  const upper = { ...lower, host: "example.com", scope: "ACME/eng", key: "ENG-7" };
  expect(threadIssueKeyOf(lower)).toBe(threadIssueKeyOf(upper));
  expect(threadIssueKeysEqual(lower, upper)).toBe(true);
  for (const other of [
    { host: "other.example.com" },
    { scope: "other/ENG" },
    { key: "ENG-8" },
    { tracker: IssueTrackerKind.make("plugin") },
  ]) {
    expect(threadIssueKeysEqual(lower, { ...upper, ...other })).toBe(false);
  }
});

it("keeps plugin key case and numeric tracker keys exact", () => {
  const key = {
    tracker: IssueTrackerKind.make("plugin"),
    host: "example.com",
    scope: "acme/web",
    key: "Ticket-a",
  };
  expect(threadIssueKeysEqual(key, { ...key, key: "TICKET-A" })).toBe(false);
  for (const tracker of ["github", "gitlab", "forgejo", "azure-devops"]) {
    const numeric = { ...key, tracker: IssueTrackerKind.make(tracker), key: "7" };
    expect(threadIssueKeysEqual(numeric, { ...numeric, key: " 7 " })).toBe(true);
    expect(threadIssueKeysEqual(numeric, { ...numeric, key: "07" })).toBe(false);
    expect(threadIssueKeysEqual({ ...numeric, key: "Ab-7" }, { ...numeric, key: "AB-7" })).toBe(
      false,
    );
  }
});

it.each(["Mount", "Nested/Mount"])(
  "keeps Forgejo mount %s exact while ignoring owner and repo case",
  (mount) => {
    const issue = {
      tracker: IssueTrackerKind.make("forgejo"),
      host: "Forgejo.test",
      scope: `${mount}/Acme/Web`,
      key: "42",
    };
    const alias = { ...issue, host: "forgejo.test", scope: `${mount}/acme/web` };
    const otherMount = { ...alias, scope: `${mount.toLowerCase()}/acme/web` };
    expect(threadIssueKeysEqual(issue, alias)).toBe(true);
    expect(threadIssueKeyOf(issue)).not.toBe(threadIssueKeyOf(otherMount));
    expect(threadIssueKeysEqual(issue, otherMount)).toBe(false);
    expect(issueListCursorKey(alias)).not.toBe(issueListCursorKey(otherMount));
  },
);

it.each(["forgejo", "github", "gitlab", "azure-devops", "linear", "jira", "plugin"])(
  "retains %s scope case matching without a Forgejo mount",
  (tracker) => {
    const issue = {
      tracker: IssueTrackerKind.make(tracker),
      host: "example.test",
      scope: "Acme/Web",
      key: "42",
    };
    expect(threadIssueKeysEqual(issue, { ...issue, scope: "acme/web" })).toBe(true);
    if (tracker !== "forgejo") {
      expect(
        threadIssueKeysEqual(
          { ...issue, scope: "Mount/Acme/Web" },
          { ...issue, scope: "mount/acme/web" },
        ),
      ).toBe(true);
    }
  },
);

it("preserves optional issue body edit safety on the wire", () => {
  const decode = Schema.decodeUnknownSync(
    Schema.Struct({ bodyEditable: IssueDetail.fields.bodyEditable }),
  );
  expect(decode({})).toEqual({});
  for (const bodyEditable of [true, false]) {
    expect(decode({ bodyEditable })).toEqual({ bodyEditable });
  }
  expect(() => decode({ bodyEditable: "false" })).toThrow();
});

it("keeps legacy tracker inputs and preserves explicit account selectors", () => {
  const connect = Schema.decodeUnknownSync(IssueTrackerConnectInput);
  const bind = Schema.decodeUnknownSync(IssueTrackerBindProjectInput);
  for (const input of [
    { tracker: "linear", token: "token" },
    { tracker: "linear", token: "token", addAccount: true },
    { tracker: "linear", token: null, connectionId: "account-a" },
  ])
    expect(connect(input)).toEqual(input);
  const input = {
    projectId: "project",
    binding: { tracker: "linear", scope: "acme/ENG", connectionId: "account-a" },
  };
  expect(bind(input)).toEqual(input);
  expect(bind({ projectId: "project", binding: null, tracker: "linear" })).toEqual({
    projectId: "project",
    binding: null,
    tracker: "linear",
  });
  expect(
    bind({ projectId: "project", tracker: "linear", connectionId: "account-a", binding: null }),
  ).toEqual({ projectId: "project", tracker: "linear", connectionId: "account-a", binding: null });
  expect(bind({ projectId: "project", binding: null })).toEqual({
    projectId: "project",
    binding: null,
  });
  expect(() => connect({ tracker: "linear", token: null, connectionId: "" })).toThrow();
});

it("preserves all per-tracker project bindings without changing legacy records", () => {
  const decode = Schema.decodeUnknownSync(IssueTrackerConnectionList);
  const linear = { tracker: "linear", scope: "acme/ENG", connectionId: "account-a" };
  const jira = {
    tracker: "jira",
    scope: "OPS",
    host: "example.atlassian.net",
    connectionId: "account-b",
  };
  const legacy = { trackers: [], bindings: { project: { tracker: "linear", scope: "acme/ENG" } } };
  expect(decode(legacy)).toEqual(legacy);
  const current = {
    ...legacy,
    accounts: [
      {
        tracker: "linear",
        displayName: "Linear",
        host: "linear.app",
        scopeNoun: "team",
        credential: { label: "Token", helpUrl: null },
        connected: true,
        account: "Alice",
        detail: null,
        scopes: [],
        connectionId: "account-a",
      },
    ],
    projectBindings: { project: [linear, jira] },
  };
  expect(decode(current)).toEqual(current);
});

it("keeps explicit accounts separate in source cursor keys and preserves legacy keys", () => {
  const source = { tracker: "linear", host: "LINEAR.APP", scope: "acme/ENG" };
  expect(issueListCursorKey(source)).toBe("linear linear.app acme/ENG");
  const a = { ...source, connectionId: "account-a" };
  const b = { ...source, connectionId: "account-b" };
  expect(issueListCursorKey(a)).not.toBe(issueListCursorKey(b));
  expect(issueListCursorKey(a)).not.toBe(issueListCursorKey(source));
});

it("retains selected account identity through refs and same-native-key thread links", () => {
  const key = {
    tracker: IssueTrackerKind.make("linear"),
    host: "linear.app",
    scope: "acme/ENG",
    key: "eng-7",
  };
  const selected = { ...key, connectionId: "account-a" };
  expect(threadIssueKeysEqual(selected, { ...selected, key: "ENG-7" })).toBe(true);
  expect(threadIssueKeysEqual(selected, { ...selected, connectionId: "account-b" })).toBe(false);
  expect(threadIssueKeysEqual(selected, key)).toBe(false);
  const link = {
    ...selected,
    projectId: ProjectId.make("project"),
    source: "manual" as const,
    url: "https://linear.app/acme/issue/ENG-7",
    linkedAt: "2026-10-15T00:00:00Z",
    snapshot: null,
  };
  expect(decodeThreadLink(encodeThreadLink(link))).toEqual(link);
  expect(() => decodeThreadLink(link)).toThrow();
  expect(decodeScope(threadIssueRefOf(link))).toEqual({
    projectId: link.projectId,
    tracker: key.tracker,
    host: key.host,
    scope: key.scope,
    connectionId: "account-a",
  });
});

it("keeps account-specific native list errors distinct from legacy errors", () => {
  const decode = Schema.decodeUnknownSync(IssueListProjectError);
  const error = {
    projectId: "project",
    projectTitle: "Project",
    message: "Failed",
    tracker: "linear",
    host: "linear.app",
  };
  expect(decode(error)).toEqual(error);
  expect(decode({ ...error, connectionId: "Account-A" })).toEqual({
    ...error,
    connectionId: "Account-A",
  });
});

it("uses account action values that an old tracker schema rejects before dispatch", () => {
  const oldConnect = Schema.decodeUnknownSync(
    Schema.Struct({
      tracker: IssueTrackerKind,
      token: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
    }),
  );
  const oldBind = Schema.decodeUnknownSync(
    Schema.Struct({
      projectId: ProjectId,
      binding: Schema.NullOr(
        Schema.Struct({
          tracker: IssueTrackerKind,
          scope: TrimmedNonEmptyString,
          host: Schema.optional(TrimmedNonEmptyString),
        }),
      ),
    }),
  );
  const decodeConnect = Schema.decodeUnknownSync(IssueTrackerConnectInput);
  const decodeBind = Schema.decodeUnknownSync(IssueTrackerBindProjectInput);
  expect(
    oldConnect({
      tracker: "linear",
      token: "account-b-token",
      addAccount: true,
      connectionId: "account-b",
    }),
  ).toEqual({ tracker: "linear", token: "account-b-token" });
  const nativeWrites: unknown[] = [];
  const dispatch = (decode: (input: unknown) => unknown, input: unknown) =>
    nativeWrites.push(decode(input));
  for (const request of [
    { tracker: "linear", token: { value: "new-token" }, addAccount: true },
    { tracker: "linear", token: { value: "rotated-token" }, connectionId: "account-a" },
    { tracker: "linear", token: { value: null }, connectionId: "account-a" },
  ]) {
    expect(decodeConnect(request)).toEqual(request);
    expect(() => dispatch(oldConnect, request)).toThrow();
  }
  for (const binding of [null, { tracker: "linear", scope: "ENG", connectionId: "account-a" }]) {
    const request = {
      projectId: "project",
      tracker: "linear",
      connectionId: "account-a",
      binding: { value: binding },
    };
    expect(decodeBind(request)).toEqual(request);
    expect(() => dispatch(oldBind, request)).toThrow();
  }
  expect(nativeWrites).toEqual([]);
});

it("accepts empty rich-comment fallbacks and retains comment body bounds", () => {
  const decodeEdit = Schema.decodeUnknownSync(IssueEditCommentInput);
  const decodeComment = Schema.decodeUnknownSync(IssueCommentInput);
  const ref = {
    projectId: "project",
    tracker: "jira",
    host: "jira.example.com",
    scope: "OPS",
    key: "OPS-7",
  };
  const input = { ...ref, commentId: "comment", body: "" };
  for (const richBody of [
    {
      format: "adf",
      document:
        '{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"Added text"}]}]}',
    },
    { format: "jira-wiki", document: "*Added text*" },
  ]) {
    const richEdit = { ...input, richBody };
    expect(decodeEdit(richEdit)).toEqual(richEdit);
    expect(() => decodeEdit({ ...richEdit, body: "x".repeat(65_537) })).toThrow();
  }
  for (const body of ["  edited text", "x".repeat(65_536)]) {
    expect(decodeEdit({ ...input, body }).body).toBe(body);
    expect(decodeComment({ ...ref, body }).body).toBe(body);
  }
  expect(() => decodeEdit({ ...input, body: "x".repeat(65_537) })).toThrow();
  expect(() => decodeComment({ ...ref, body: "" })).toThrow();
  expect(() => decodeComment({ ...ref, body: "x".repeat(65_537) })).toThrow();
});

it("decodes the optional native dependency permission", () => {
  const decode = Schema.decodeUnknownSync(IssueViewerPermissions);
  const base = { setState: true, comment: true, edit: false, labels: true, assignees: true };
  expect(decode(base)).toEqual(base);
  for (const updateDependencies of [true, false])
    expect(decode({ ...base, updateDependencies })).toEqual({ ...base, updateDependencies });
  expect(() => decode({ ...base, updateDependencies: "yes" })).toThrow();
});

it("bounds native field values and rich JSON before tracker calls", () => {
  const fields = Schema.decodeUnknownSync(IssueInputField);
  const values = Schema.decodeUnknownSync(IssueFieldValues);
  const rich = Schema.decodeUnknownSync(IssueRichBody);
  const candidates = Schema.decodeUnknownSync(IssueCandidates);
  const wiki = { format: "jira-wiki", document: "h2. Title\n\n*bold* !keep.png!\n" };
  expect(rich(wiki)).toEqual(wiki);
  expect(() => rich({ ...wiki, document: "x".repeat(65_537) })).toThrow();
  const html = { format: "azure-html", document: "<table><tr><td>A</td></tr></table>\r\n" };
  expect(rich(html)).toEqual(html);
  expect(rich({ ...html, document: "" })).toEqual({ ...html, document: "" });
  expect(() => rich({ ...html, document: "x".repeat(65_537) })).toThrow();
  expect(() => rich({ format: "html", document: "<p>A</p>" })).toThrow();
  const field = { id: "custom", label: "Choice", kind: "select", required: true };
  expect(fields({ ...field, options: [{ value: "1", label: "One" }] }).options).toHaveLength(1);
  expect(() => fields({ ...field, label: "x".repeat(1025) })).toThrow();
  expect(() =>
    fields({
      ...field,
      options: Array.from({ length: 101 }, () => ({ value: "1", label: "One" })),
    }),
  ).toThrow();
  expect(() =>
    candidates({
      labels: [],
      assignees: [],
      fields: Array.from({ length: 1001 }, () => field),
      truncated: false,
    }),
  ).toThrow();
  const largeFields = Array.from({ length: 1000 }, (_, i) => ({ ...field, id: `custom_${i}` }));
  expect(
    candidates({ labels: [], assignees: [], fields: largeFields, truncated: false }).fields,
  ).toEqual(largeFields);
  expect(decodeState({ category: "open", name: "Start", fields: largeFields }).fields).toEqual(
    largeFields,
  );
  expect(() =>
    decodeState({ category: "open", name: "Start", fields: [...largeFields, field] }),
  ).toThrow();
  expect(values({ text: "value", users: ["a", "b"] })).toEqual({
    text: "value",
    users: ["a", "b"],
  });
  const largeValues = Object.fromEntries(largeFields.map(({ id }) => [id, "x"]));
  expect(values(largeValues)).toEqual(largeValues);
  expect(() =>
    values(Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [String(i), ""]))),
  ).toThrow();
  expect(() => values({ users: Array.from({ length: 101 }, () => "x") })).toThrow();
  expect(() => values({ first: "x".repeat(32768), second: "x".repeat(32768) })).toThrow();
  expect(rich({ format: "adf", document: '{"type":"doc"}' }).format).toBe("adf");
  expect(() => rich({ format: "adf", document: "not json" })).toThrow();
  expect(() => rich({ format: "adf", document: JSON.stringify("x".repeat(262144)) })).toThrow();
});

it("keeps cascading parent and child choices through candidate, transition and create codecs", () => {
  const field = {
    id: "customfield_10001",
    label: "Location",
    required: true,
    kind: "cascading-select",
    options: [{ value: "101", label: "North", children: [{ value: "102", label: "East" }] }],
  };
  const candidates = decodeNativeCandidates({
    labels: [],
    assignees: [],
    fields: [field],
    truncated: false,
  });
  expect(candidates.fields).toEqual([field]);
  expect(decodeState({ category: "open", name: "Start", fields: [field] }).fields).toEqual([field]);
  const selection = JSON.stringify({ id: "101", child: { id: "102" } });
  const create = {
    projectId: "web",
    tracker: "jira",
    scope: "ENG",
    title: "New",
    body: "",
    labels: [],
    assignees: [],
    fieldValues: { [field.id]: selection },
  };
  expect(decodeNativeCreate(create).fieldValues).toEqual(create.fieldValues);
  expect(() =>
    decodeNativeField({
      ...field,
      options: [
        {
          ...field.options[0],
          children: Array.from({ length: 101 }, () => ({ value: "102", label: "East" })),
        },
      ],
    }),
  ).toThrow();
});

it("allows 8192-character issue cursors and refuses larger pages", () => {
  const cursor = "x".repeat(8192);
  expect(decodePage({ cursor }).cursor).toBe(cursor);
  expect(() => decodePage({ cursor: cursor + "x" })).toThrow();
  const dependencies = Schema.decodeUnknownSync(IssueDependenciesPage);
  expect(dependencies({ items: [], nextCursor: cursor }).nextCursor).toBe(cursor);
  expect(() => dependencies({ items: [], nextCursor: cursor + "x" })).toThrow();
});

it("keeps unknown linked pull request draft state absent", () => {
  const decode = Schema.decodeUnknownSync(IssueLinkedPullRequest);
  const link = {
    repository: "acme/web",
    number: 7,
    title: "Change",
    url: "https://gitcafe.example/acme/web/pulls/7",
    state: null,
    closesIssue: false,
  };
  expect(decode(link)).toEqual(link);
  expect(decode({ ...link, isDraft: false }).isDraft).toBe(false);
  expect(decode({ ...link, isDraft: true }).isDraft).toBe(true);
});

it("keeps Jira instance paths distinct in issue, host and cursor keys", () => {
  const ref = { tracker: "jira", host: "JIRA.EXAMPLE:8443/Jira", scope: "OPS", key: "OPS-7" };
  const other = { ...ref, host: "jira.example:8443/jira" };
  expect(issueHostKey(ref.host)).toBe("jira.example:8443/Jira");
  expect(issueTrackerHostKey(ref)).not.toBe(issueTrackerHostKey(other));
  expect(issueListCursorKey(ref)).not.toBe(issueListCursorKey(other));
  expect(threadIssueKeyOf(ref)).not.toBe(threadIssueKeyOf(other));
  expect(threadIssueKeyOf(ref)).toBe(threadIssueKeyOf({ ...ref, host: "jira.example:8443/Jira" }));
});

it("accepts ordered first and continued activity pages with native reference links", () => {
  const ref = { projectId: "web", tracker: "github", scope: "org/repo", key: "7" };
  expect(decodeComments({ ...ref, order: "asc" })).toMatchObject({ order: "asc" });
  expect(decodeHistoryInput({ ...ref, order: "desc" })).toMatchObject({
    order: "desc",
  });
  const selected = {
    ...ref,
    tracker: "linear",
    scope: "acme/ENG",
    key: "ENG-7",
    projectId: { value: "web", connectionId: "ExactB" },
    order: "asc",
  };
  expect(decodeHistoryRpc(selected)).toMatchObject({ order: "asc", connectionId: "ExactB" });
  expect(decodeCommentsRpc(selected)).toMatchObject({ order: "asc", connectionId: "ExactB" });
  expect(() => decodeComments({ ...ref, order: "sideways" })).toThrow();
  const event = {
    id: "native",
    kind: "referenced",
    actor: null,
    createdAt: "2026-10-16T00:00:00.000Z",
    detail: "Source",
    url: "https://github.com/org/repo/pull/8#issuecomment-42",
    reference: {
      url: "https://github.com/org/repo/pull/8",
      title: "Source",
      identifier: "org/repo#8",
    },
  };
  expect(decodeEvent(event)).toEqual(event);
});

it("preserves native activity order limits without changing legacy capabilities", () => {
  const decode = Schema.decodeUnknownSync(IssueCapabilities);
  const capabilities = {
    create: false,
    edit: false,
    comment: true,
    labels: false,
    assignees: false,
    reactions: false,
    templates: false,
    linkedPullRequests: false,
    events: true,
    search: false,
    involvements: ["all"],
    states: [],
    closeReasons: [],
  };
  expect(decode(capabilities).commentOrders).toBeUndefined();
  expect(decode({ ...capabilities, commentOrders: ["asc"], historyOrders: ["asc"] })).toMatchObject(
    { commentOrders: ["asc"], historyOrders: ["asc"] },
  );
  expect(() => decode({ ...capabilities, commentOrders: ["sideways"] })).toThrow();
});
