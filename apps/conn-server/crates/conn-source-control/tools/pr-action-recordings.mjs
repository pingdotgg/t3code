// Record T3's real API calls on an in-memory HTTP client. No CLI, credentials or network.
import { importSource, packageImporter } from "../../../tools/monorepo.mjs";
const pkg = packageImporter("packages/source-control-github");
const Effect = await pkg("effect/Effect");
const Layer = await pkg("effect/Layer");
const Redacted = await pkg("effect/Redacted");
const { HttpClient, HttpClientResponse } = await pkg("effect/http");
const NodeServices = await packageImporter("apps/server")("@effect/platform-node/NodeServices");
const moduleOf = (name) => importSource(`packages/source-control-github/src/server/${name}.ts`);
const [Api, Rest, Credentials, App, Access, Quota, Limits, Host] = await Promise.all([
  moduleOf("GitHubPullRequestApi"), moduleOf("GitHubRest"), moduleOf("GitHubCredentials"),
  moduleOf("GitHubAppSignIn"), moduleOf("GitHubAppAccess"), moduleOf("GitHubQuota"),
  importSource("packages/source-control-core/src/server/SourceControlRateLimit.ts"),
  importSource("packages/source-control-testing/src/TestSourceControlHost.ts"),
]);
const { PullRequestReactionContent } = await importSource("packages/contracts/src/pullRequest.ts");

export async function recordCapabilities() {
  const Provider = await moduleOf("GitHubPullRequestProvider");
  const provider = await Effect.runPromise(Effect.scoped(Provider.make.pipe(Effect.provideService(Api.GitHubPullRequestApi,{}))));
  return provider.capabilities;
}

export async function recordActions() {
  const cases = [];
  for (const [method, apiMethod, input, refusal] of [
    ["comment","commentOnPullRequest",{body:"  hello\n"}],
    ["replyToThread","replyToReviewThread",{threadId:"T7",body:"reply"}],
    ["setThreadResolution","setReviewThreadResolution",{threadId:"T7",resolved:true}],
    ["setThreadResolution","setReviewThreadResolution",{threadId:"T7",resolved:false}],
    ...PullRequestReactionContent.literals.flatMap(content=>[
      ["setReaction","setReaction",{content,reacted:true}],
      ["setReaction","setReaction",{subjectId:"C7",content,reacted:false}],
    ]),
    ["updateComment","updateComment",{commentId:"C7",kind:"issue-comment",body:"issue"}],
    ["updateComment","updateComment",{commentId:"C7",kind:"review-comment",body:"review"}],
    ["update","updatePullRequest",{body:"",maintainerCanModify:false}],
    ["submitReview","submitReview",{verdict:"approve",body:"",comments:[]}],
    ["requestReviewers","setReviewerRequest",{reviewers:[{id:"reader",kind:"user"},{id:"core",kind:"team"}],requested:true}],
    ["requestReviewers","setReviewerRequest",{reviewers:[{id:"reader",kind:"user"}],requested:false}],
    ["setLabels","setLabels",{labels:["bug"],applied:true}],
    ["setLabels","setLabels",{labels:["good first issue","area/web"],applied:false}],
    ["comment","commentOnPullRequest",{body:"refused"},{status:200,body:{errors:[{type:"FORBIDDEN",message:"Cannot comment",path:["addComment"]}]}}],
    ["comment","commentOnPullRequest",{body:"missing"},{status:200,body:{errors:[{type:"NOT_FOUND",message:"Missing subject",path:["addComment"]}]}}],
    ["comment","commentOnPullRequest",{body:"missing nested"},{status:200,body:{errors:[{type:"NOT_FOUND",message:"Missing nested field",path:["addComment","commentEdge"]}]}}],
    ["submitReview","submitReview",{verdict:"approve",body:"",comments:[]},{status:422,body:{message:"Validation Failed",errors:[{field:"body",code:"missing"},"summary required",{message:"cannot approve"}]}}],
    ["setLabels","setLabels",{labels:["bug"],applied:true},{status:403,body:{message:"Resource not accessible by integration"}}],
    ["setLabels","setLabels",{labels:["bug"],applied:true},{status:403,body:{message:"You have triggered an abuse detection mechanism."}}],
  ]) {
    const requests = [];
    const http = Layer.succeed(HttpClient.HttpClient,HttpClient.make(request=>Effect.sync(()=>{
      const path = new URL(request.url).pathname;
      const body = request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : null;
      requests.push({method:request.method,path,body});
      let response = {};
      if(path.endsWith("/graphql")) {
        const query = body.query;
        const root = /\)\{(\w+)(?:\(|\{|@)/.exec(query)?.[1];
        response = query.includes("query PullRequestSubject")
          ? {data:{repository:{pullRequest:{id:"PR7"}},node:{__typename:"IssueComment",id:"C7",pullRequest:{id:"PR7"}}}}
          : query.includes("query PullRequestNodeId")
            ? {data:{repository:{pullRequest:{id:"PR7"}}}}
            : {data:root === undefined ? {} : {[root]:null}};
      }
      const fail = refusal !== undefined && (!path.endsWith("/graphql") || body.query.startsWith("mutation "));
      return HttpClientResponse.fromWeb(request,new Response(JSON.stringify(fail ? refusal.body : response),{status:fail ? refusal.status : 200,headers:{"content-type":"application/json"}}));
    })));
    const credentials = Layer.succeed(Credentials.GitHubCredentials,{
      get:host=>Effect.succeed({host,token:Redacted.make("fake-pr-token"),source:"gh",fingerprint:"fixture"}),
      saved:()=>Effect.succeedNone, fingerprint:()=>Effect.succeed("fixture"), invalidate:()=>Effect.void,
    });
    const signedOut = Layer.mock(App.GitHubAppSignIn)({enabled:false,token:()=>Effect.succeedNone,invalidate:()=>Effect.void});
    const layer = Api.layer.pipe(
      Layer.provideMerge(Access.layer),
      Layer.provide(Rest.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(credentials,http,signedOut)),
        Layer.provideMerge(Quota.layer),Layer.provideMerge(Limits.layer),
      )),Layer.provide(Host.layer()),Layer.provide(NodeServices.layer),
    );
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
      const api = yield* Api.GitHubPullRequestApi;
      return yield* Effect.result(api[apiMethod]({cwd:"/fixture",host:"github.com",repository:"a/b",number:7,...input}));
    }).pipe(Effect.provide(layer))));
    if(refusal === undefined && outcome._tag !== "Success") throw new Error(`Unexpected T3 failure: ${outcome.failure}`);
    if(refusal !== undefined && outcome._tag !== "Failure") throw new Error("T3 refusal fixture succeeded");
    cases.push({method,input,requests,...(refusal===undefined?{}:{refusal,error:{tag:outcome.failure._tag,detail:outcome.failure.message}})});
  }
  return cases;
}

// T3's `runPullRequestAction`, `readCheckLogs` and `rerunChecks` on an in-memory host that
// answers each GraphQL operation (by name) and REST request (`METHOD /path?query`) from the
// case's own table. The Rust test answers from the same table and compares the trace.
export async function recordRunActions() {
  const actionState = (fields = {}) => ({ data: { repository: { pullRequest: { id: "PR7", headRefOid: "head7", isMergeQueueEnabled: false, mergeStateStatus: "BLOCKED", baseRef: { compare: { behindBy: 2 } }, ...fields } } } });
  const credited = "Change body\n\nCo-authored-by: Claude <noreply@anthropic.com>\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)";
  const mergeMessage = (fields = {}) => ({ data: { repository: { pullRequest: { isMergeQueueEnabled: false, headRefOid: "head7", viewerMergeBodyText: credited, ...fields } } } });
  const job = (id, run) => ({ status: 200, body: { id, run_id: run } });
  const checks = [
    { name: "build", url: "https://github.com/a/b/actions/runs/11/job/21" },
    { name: "lint", url: "https://github.com/a/b/actions/runs/11/job/22" },
    { name: "external", url: "https://ci.example.com/build/1" },
    { name: "gone", url: "https://github.com/a/b/actions/runs/12/job/23" },
    { name: "other run", url: "https://github.com/a/b/runs/24" },
  ];
  const cases = [
    ...["ready", "draft", "close", "reopen", "disable-auto-merge"].map((action) => ({ method: "runPullRequestAction", input: { action }, responses: {} })),
    { method: "runPullRequestAction", input: { action: "revert" }, responses: { "graphql RevertPullRequest": { data: { revertPullRequest: { revertPullRequest: { id: "PR8" } } } } } },
    { method: "runPullRequestAction", input: { action: "ready" }, responses: { "graphql PullRequestNodeId": { data: { repository: { pullRequest: null } } } } },
    { method: "runPullRequestAction", input: { action: "merge" }, responses: { "graphql PullRequestActionState": actionState() } },
    { method: "runPullRequestAction", input: { action: "merge", mergeMethod: "squash", expectedHeadSha: "abc" }, responses: { "graphql PullRequestActionState": actionState() } },
    { method: "runPullRequestAction", input: { action: "merge", mergeMethod: "rebase" }, responses: { "graphql PullRequestActionState": actionState({ isMergeQueueEnabled: true }) } },
    { method: "runPullRequestAction", input: { action: "enable-auto-merge", mergeMethod: "squash" }, responses: { "graphql PullRequestActionState": actionState() } },
    { method: "runPullRequestAction", input: { action: "enable-auto-merge" }, responses: { "graphql PullRequestActionState": actionState({ mergeStateStatus: "clean" }) } },
    { method: "runPullRequestAction", input: { action: "merge", removeAgentCreditsOnMerge: true }, responses: { "graphql PullRequestActionState": actionState(), "graphql PullRequestMergeMessage": mergeMessage() } },
    { method: "runPullRequestAction", input: { action: "merge", mergeMethod: "squash", removeAgentCreditsOnMerge: true, expectedHeadSha: "pinned" }, responses: { "graphql PullRequestActionState": actionState(), "graphql PullRequestMergeMessage": mergeMessage() } },
    { method: "runPullRequestAction", input: { action: "merge", removeAgentCreditsOnMerge: true }, responses: { "graphql PullRequestActionState": actionState(), "graphql PullRequestMergeMessage": mergeMessage({ isMergeQueueEnabled: true }) } },
    { method: "runPullRequestAction", input: { action: "merge", mergeMethod: "rebase", removeAgentCreditsOnMerge: true }, responses: { "graphql PullRequestActionState": actionState() } },
    { method: "runPullRequestAction", input: { action: "merge", removeAgentCreditsOnMerge: true }, responses: { "graphql PullRequestActionState": actionState(), "graphql PullRequestMergeMessage": mergeMessage({ viewerMergeBodyText: "Plain body" }) } },
    { method: "runPullRequestAction", input: { action: "update-branch" }, responses: { "graphql PullRequestActionState": actionState() } },
    { method: "runPullRequestAction", input: { action: "update-branch", updateMethod: "rebase" }, responses: { "graphql PullRequestActionState": actionState() } },
    { method: "runPullRequestAction", input: { action: "update-branch" }, responses: { "graphql PullRequestActionState": actionState({ baseRef: { compare: { behindBy: 0 } } }) } },
    { method: "runPullRequestAction", input: { action: "merge" }, responses: { "graphql PullRequestActionState": { data: { repository: { pullRequest: null } } } } },
    { method: "readCheckLogs", input: { checks: checks.slice(0, 4), tailLines: 2 }, responses: {
      "GET /repos/a/b/actions/jobs/21/logs": { status: 200, text: "one\ntwo\nthree\n" },
      "GET /repos/a/b/actions/jobs/22/logs": { status: 200, text: "only" },
      "GET /repos/a/b/actions/jobs/23/logs": { status: 404, body: { message: "Not Found" } },
    } },
    { method: "readCheckLogs", input: { checks: checks.slice(0, 1), tailLines: 5 }, responses: {
      "GET /repos/a/b/actions/jobs/21/logs": { status: 500, body: { message: "Server Error" } },
    } },
    { method: "rerunChecks", input: { checks }, responses: {
      "GET /repos/a/b/actions/jobs/21": job(21, 11), "GET /repos/a/b/actions/jobs/22": job(22, 11),
      "GET /repos/a/b/actions/jobs/23": { status: 404, body: { message: "Not Found" } },
      "GET /repos/a/b/actions/jobs/24": job(24, 13),
      "GET /repos/a/b/actions/runs/11/jobs?filter=latest&per_page=100": { status: 200, body: { total_count: 3, jobs: [{ id: 21, conclusion: "failure" }, { id: 22, conclusion: "cancelled" }, { id: 25, conclusion: "success" }] } },
      "POST /repos/a/b/actions/jobs/24/rerun": { status: 403, body: { message: "Already running" } },
    } },
    { method: "rerunChecks", input: { checks: checks.slice(0, 2) }, responses: {
      "GET /repos/a/b/actions/jobs/21": job(21, 11), "GET /repos/a/b/actions/jobs/22": job(22, 11),
      "GET /repos/a/b/actions/runs/11/jobs?filter=latest&per_page=100": { status: 200, body: { total_count: 2, jobs: [{ id: 21, conclusion: "failure" }, { id: 22, conclusion: "timed_out" }] } },
    } },
    { method: "rerunChecks", input: { checks: checks.slice(0, 2) }, responses: {
      "GET /repos/a/b/actions/jobs/21": job(21, 11), "GET /repos/a/b/actions/jobs/22": { status: 200, body: { id: 22 } },
    } },
  ];
  const out = [];
  for (const entry of cases) {
    const requests = [];
    const http = Layer.succeed(HttpClient.HttpClient, HttpClient.make((request) => Effect.sync(() => {
      const url = new URL(request.url);
      const path = url.pathname + url.search;
      const body = request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : null;
      requests.push({ method: request.method, path, body });
      const operation = path.endsWith("/graphql") ? /^(?:query|mutation) (\w+)/.exec(body.query)?.[1] : undefined;
      const key = operation === undefined ? `${request.method} ${path}` : `graphql ${operation}`;
      const answer = entry.responses[key] ?? (operation === "PullRequestNodeId" ? { data: { repository: { pullRequest: { id: "PR7" } } } } : operation === undefined ? { status: 200, body: {} } : { data: {} });
      const status = answer.status ?? 200;
      const text = answer.text ?? JSON.stringify(answer.body ?? answer);
      return HttpClientResponse.fromWeb(request, new Response(text, { status, headers: { "content-type": answer.text === undefined ? "application/json" : "text/plain" } }));
    })));
    const credentials = Layer.succeed(Credentials.GitHubCredentials, {
      get: (host) => Effect.succeed({ host, token: Redacted.make("fake-pr-token"), source: "gh", fingerprint: "fixture" }),
      saved: () => Effect.succeedNone, fingerprint: () => Effect.succeed("fixture"), invalidate: () => Effect.void,
    });
    const signedOut = Layer.mock(App.GitHubAppSignIn)({ enabled: false, token: () => Effect.succeedNone, invalidate: () => Effect.void });
    const layer = Api.layer.pipe(
      Layer.provideMerge(Access.layer),
      Layer.provide(Rest.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(credentials, http, signedOut)),
        Layer.provideMerge(Quota.layer), Layer.provideMerge(Limits.layer),
      )), Layer.provide(Host.layer()), Layer.provide(NodeServices.layer),
    );
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const api = yield* Api.GitHubPullRequestApi;
      return yield* Effect.result(api[entry.method]({ cwd: "/fixture", host: "github.com", repository: "a/b", number: 7, ...entry.input }));
    }).pipe(Effect.provide(layer))));
    out.push({
      ...entry,
      requests,
      ...(outcome._tag === "Success"
        ? { result: outcome.success ?? null }
        : { error: { tag: outcome.failure._tag, detail: outcome.failure.message } }),
    });
  }
  return out;
}

// T3's `GitHubIssueTracker` on the same in-memory host: each case answers GraphQL operations by
// name and REST requests by `METHOD /path`, and records the requests and the result.
export async function recordIssueTracker() {
  const Tracker = await moduleOf("GitHubIssueTracker");
  const issue = (fields = {}) => ({ id: "I7", number: 7, title: "Broken chip", url: "https://github.com/a/b/issues/7",
    state: "OPEN", stateReason: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", closedAt: null,
    author: { __typename: "User", login: "nick", name: "Nick", avatarUrl: "https://avatars.example/nick" }, body: "Body",
    assignees: { nodes: [{ login: "ann", name: null, avatarUrl: "https://avatars.example/ann" }], pageInfo: { hasNextPage: false, endCursor: null } },
    labels: { nodes: [{ name: "bug", color: "d73a4a" }], pageInfo: { hasNextPage: false, endCursor: null } },
    comments: { totalCount: 1, nodes: [{ id: "C1", author: { __typename: "User", login: "ann", name: null, avatarUrl: "https://avatars.example/ann" }, body: "Same here", createdAt: "2026-11-02T00:00:00Z", url: "https://github.com/a/b/issues/7#c1", reactionGroups: [{ content: "THUMBS_UP", viewerHasReacted: true, reactors: { totalCount: 2, nodes: [{ __typename: "User", login: "nick" }, { __typename: "User", login: "ann" }] } }] }], pageInfo: { hasPreviousPage: true, startCursor: "older" } },
    reactionGroups: [], viewerCanUpdate: true, viewerCanClose: true, viewerCanReopen: false,
    closedByPullRequestsReferences: { nodes: [{ number: 9, title: "Fix", url: "https://github.com/a/b/pull/9", state: "OPEN", isDraft: true, repository: { nameWithOwner: "a/b" } }], pageInfo: { hasNextPage: false, endCursor: null } },
    timelineItems: { nodes: [
      { __typename: "LabeledEvent", id: "E1", createdAt: "2026-11-01T01:00:00Z", actor: { __typename: "User", login: "nick", avatarUrl: "https://avatars.example/nick" }, label: { name: "bug" } },
      { __typename: "CrossReferencedEvent", id: "E2", createdAt: "2026-11-01T02:00:00Z", actor: null, source: { __typename: "PullRequest", number: 11, title: "Other", url: "https://github.com/a/b/pull/11", state: "MERGED", isDraft: false, repository: { nameWithOwner: "a/b" } } },
      { __typename: "MilestonedEvent", id: "E3", createdAt: "2026-11-01T03:00:00Z" },
    ] },
    ...fields });
  const detail = (fields) => ({ data: { viewer: { login: "nick" }, repository: { viewerPermission: "TRIAGE", issue: issue(fields) } } });
  const cases = [
    { method: "listIssues", input: { scope: "a/b", state: "open", involvement: "all", limit: 30, sort: "updated", query: 'chip "quoted" \\\\ x', labels: ["bug", "good first"], assignee: "ann" }, responses: { "graphql IssueSearch": { data: { search: { nodes: [{ __typename: "Issue", ...issue() }, { __typename: "PullRequest" }], pageInfo: { hasNextPage: true, endCursor: "next" } } } } } },
    { method: "listIssues", input: { scope: "a/b", state: "closed", involvement: "assigned", viewer: "nick", limit: 500, sort: "created", cursor: "c1" }, responses: { "graphql IssueSearch": { data: { search: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } },
    { method: "listIssues", input: { scope: "not a repo", state: "open", involvement: "all", limit: 1, sort: "updated" }, responses: {} },
    { method: "getIssue", input: { scope: "a/b", key: "7" }, responses: { "graphql IssueDetail": detail() } },
    { method: "getIssue", input: { scope: "a/b", key: "7" }, responses: {
      "graphql IssueDetail": detail({ labels: { nodes: [{ name: "bug", color: "eeeeee" }], pageInfo: { hasNextPage: true, endCursor: "L1" } } }),
      "graphql IssueCollections": { data: { repository: { issue: { labels: { nodes: [{ name: "ui", color: "fff" }], pageInfo: { hasNextPage: false, endCursor: null } } } } } },
    } },
    { method: "getIssue", input: { scope: "a/b", key: "07" }, responses: {} },
    { method: "getIssue", input: { scope: "a/b", key: "7" }, responses: { "graphql IssueDetail": { data: { viewer: { login: "nick" }, repository: { viewerPermission: "READ", issue: null } } } } },
    { method: "getComments", input: { scope: "a/b", key: "7", cursor: "older" }, responses: { "graphql IssueComments": { data: { viewer: { login: "nick" }, repository: { issue: { comments: issue().comments } } } } } },
    { method: "create", input: { scope: "a/b", title: "New", body: "Body", labels: ["bug"], assignees: [] }, responses: { "POST /repos/a/b/issues": { status: 201, body: { number: 12, html_url: "https://github.com/a/b/issues/12" } } } },
    { method: "comment", input: { scope: "a/b", key: "7", body: "Hi" }, responses: { "graphql IssueNodeId": { data: { repository: { issue: { id: "I7", state: "OPEN", stateReason: null } } } } } },
    { method: "comment", input: { scope: "a/b", key: "9", body: "Hi" }, responses: { "graphql IssueNodeId": { data: { repository: { issue: null } } } } },
    { method: "update", input: { scope: "a/b", key: "7", title: "T", labels: ["Bug", "bug"] }, responses: { "graphql IssueNodeId": { data: { repository: { issue: { id: "I7", state: "OPEN", stateReason: null } } } }, "PATCH /repos/a/b/issues/7": { status: 200, body: { labels: [{ name: "bug" }], assignees: [] } } } },
    { method: "update", input: { scope: "a/b", key: "7", assignees: ["ann"] }, responses: { "graphql IssueNodeId": { data: { repository: { issue: { id: "I7", state: "OPEN", stateReason: null } } } }, "PATCH /repos/a/b/issues/7": { status: 200, body: { labels: [], assignees: [] } } } },
    { method: "setState", input: { scope: "a/b", key: "7", state: "Not planned" }, responses: { "graphql IssueNodeId": { data: { repository: { issue: { id: "I7", state: "OPEN", stateReason: null } } } } } },
    { method: "setState", input: { scope: "a/b", key: "7", state: "Open" }, responses: { "graphql IssueNodeId": { data: { repository: { issue: { id: "I7", state: "CLOSED", stateReason: "COMPLETED" } } } } } },
    { method: "setState", input: { scope: "a/b", key: "7", state: "Duplicate" }, responses: { "graphql IssueNodeId": { data: { repository: { issue: { id: "I7", state: "CLOSED", stateReason: "COMPLETED" } } } } } },
    { method: "setState", input: { scope: "a/b", key: "7", state: "Wontfix" }, responses: { "graphql IssueNodeId": { data: { repository: { issue: { id: "I7", state: "OPEN", stateReason: null } } } } } },
    { method: "setReaction", input: { scope: "a/b", key: "7", content: "heart", reacted: true }, responses: { "graphql IssueNodeId": { data: { repository: { issue: { id: "I7", state: "OPEN", stateReason: null } } } }, "graphql AddReaction": { data: { addReaction: { reaction: { content: "HEART" } } } } } },
    { method: "setReaction", input: { scope: "a/b", key: "7", subjectId: "C1", content: "eyes", reacted: false }, responses: { "graphql IssueCommentScope": { data: { repository: { issue: { id: "I7" } }, node: { __typename: "IssueComment", issue: { id: "I7" } } } }, "graphql RemoveReaction": { data: { removeReaction: { reaction: { content: "EYES" } } } } } },
    { method: "setReaction", input: { scope: "a/b", key: "7", subjectId: "C9", content: "eyes", reacted: true }, responses: { "graphql IssueCommentScope": { data: { repository: { issue: { id: "I7" } }, node: { __typename: "IssueComment", issue: { id: "I8" } } } } } },
    { method: "listTemplates", input: { scope: "a/b" }, responses: { "graphql IssueTemplates": { data: { repository: { templateDirectory: null, issueTemplates: [{ filename: "bug.md", name: "Bug", about: null, title: "[bug] ", body: "Steps", assignees: { nodes: [{ login: "ann" }] }, labels: { nodes: [{ name: "bug" }] } }, { filename: " ", name: "Blank", about: "x", title: null, body: null, assignees: { nodes: [] }, labels: { nodes: [] } }] } } } } },
    { method: "listTemplates", input: { scope: "a/b" }, responses: { "graphql IssueTemplates": { data: { repository: { templateDirectory: { __typename: "Tree", entries: [{ name: "bug.md", object: { __typename: "Blob", text: "---", isTruncated: false } }, { name: "config.yml", object: { __typename: "Blob", text: "blank_issues_enabled: false\ncontact_links: []\n", isTruncated: false } }] }, issueTemplates: [] } } } } },
    { method: "listTemplates", input: { scope: "a/b" }, responses: { "graphql IssueTemplates": { data: { repository: null } } } },
    { method: "listTemplates", input: { scope: "a/b" }, responses: { "graphql IssueTemplates": { data: { repository: { templateDirectory: { __typename: "Tree", entries: [{ name: "config.yaml", object: { __typename: "Blob", text: "\"blank_issues_enabled\": false # no blanks\n", isTruncated: false } }] }, issueTemplates: [] } } } } },
    { method: "listTemplates", input: { scope: "a/b" }, responses: { "graphql IssueTemplates": { data: { repository: { templateDirectory: { __typename: "Tree", entries: [{ name: "config.yml", object: { __typename: "Blob", text: null, isTruncated: true } }] }, issueTemplates: [] } } } } },
    { method: "listTemplates", input: { scope: "a/b" }, responses: { "graphql IssueTemplates": { data: { repository: { templateDirectory: { __typename: "Tree", entries: [{ name: "Form.YML", object: { __typename: "Tree" } }] }, issueTemplates: [] } } } } },
    { method: "listCandidates", input: { scope: "a/b" }, responses: { "graphql IssueCandidates": { data: { repository: { labels: { nodes: [{ name: "bug", color: "d73a4a", description: null }], pageInfo: { hasNextPage: true } }, assignableUsers: { nodes: [{ login: "ann", name: "Ann", avatarUrl: "https://avatars.example/ann" }, { login: " ", name: null, avatarUrl: "https://avatars.example/x" }], pageInfo: { hasNextPage: false } } } } } } },
    { method: "getViewer", input: {}, responses: { "graphql IssueViewer": { data: { viewer: { login: "nick" } } } } },
  ];
  const out = [];
  for (const entry of cases) {
    const requests = [];
    const http = Layer.succeed(HttpClient.HttpClient, HttpClient.make((request) => Effect.sync(() => {
      const url = new URL(request.url);
      const path = url.pathname + url.search;
      const body = request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : null;
      requests.push({ method: request.method, path, body });
      const operation = path.endsWith("/graphql") ? /^(?:query|mutation) (\w+)/.exec(body.query)?.[1] : undefined;
      const key = operation === undefined ? `${request.method} ${path}` : `graphql ${operation}`;
      const answer = entry.responses[key] ?? (operation === undefined ? { status: 200, body: {} } : { data: {} });
      return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(answer.body ?? answer), { status: answer.status ?? 200, headers: { "content-type": "application/json" } }));
    })));
    const credentials = Layer.succeed(Credentials.GitHubCredentials, {
      get: (host) => Effect.succeed({ host, token: Redacted.make("fake-pr-token"), source: "gh", fingerprint: "fixture" }),
      saved: () => Effect.succeedNone, fingerprint: () => Effect.succeed("fixture"), invalidate: () => Effect.void,
    });
    const signedOut = Layer.mock(App.GitHubAppSignIn)({ enabled: false, token: () => Effect.succeedNone, invalidate: () => Effect.void });
    const rest = Rest.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(credentials, http, signedOut)),
      Layer.provideMerge(Quota.layer), Layer.provideMerge(Limits.layer),
    );
    const layer = Access.layer.pipe(
      Layer.provideMerge(rest), Layer.provide(Host.layer()), Layer.provide(NodeServices.layer),
    );
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const tracker = yield* Tracker.make;
      return yield* Effect.result(tracker[entry.method]({ cwd: "/fixture", host: "github.com", ...entry.input }));
    }).pipe(Effect.provide(layer))));
    out.push({
      ...entry, requests,
      ...(outcome._tag === "Success" ? { result: outcome.success ?? null } : { error: { reason: outcome.failure.reason, detail: outcome.failure.detail }, ...(process.env.ISSUE_DEBUG ? { cause: String(outcome.failure.cause?.reason?.cause?.message ?? outcome.failure.cause?.reason?.message ?? outcome.failure.cause?.message ?? JSON.stringify(Object.keys(outcome.failure.cause ?? {}))) } : {}) }),
    });
  }
  return out;
}
