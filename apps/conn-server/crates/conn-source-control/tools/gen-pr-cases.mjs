// Characterizations from T3's own normalization functions. No host CLI or network.
import * as fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { importSource } from "../../../tools/monorepo.mjs";
import { recordActions, recordCapabilities, recordIssueTracker, recordRunActions } from "./pr-action-recordings.mjs";
import { recordGuide } from "../../conn-server/tools/pr-guide-recordings.mjs";
import { recordCreatePullRequests } from "./pr-create-recordings.mjs";
const pure = await importSource("packages/source-control-github/src/server/gitHubPullRequestJson.ts");
const { loginAvatarUrl, gitHubViewerPermissions } = await importSource("packages/source-control-github/src/server/GitHubPullRequestProvider.ts");
const { removeAgentCredits } = await importSource("packages/source-control-core/src/server/mergeMessage.ts");
const { gitHubActionsJobId, tailLogLines } = await importSource("packages/source-control-core/src/server/PullRequestProvider.ts");
const { isGitHubHost } = await importSource("packages/source-control-github/src/server/GitHubCredentials.ts");
const { resolveGitHubRepository } = await importSource("packages/source-control-github/src/server/gitHubRepositoryResolution.ts");
const { toChangeBreakdown } = await importSource("apps/server/src/pullRequest/pullRequestChangeBreakdown.ts");
const path = new URL("../src/pull_requests/cases.json", import.meta.url);
const pr = JSON.parse(fs.readFileSync(new URL("../src/pull_requests/sample.json", import.meta.url)));
const cases = [];
const avatar = (actor) => actor === null ? null : { ...actor, avatarUrl: actor.avatarUrl ?? loginAvatarUrl(actor.login, "github.com") };
const add = (kind, input, expected) => cases.push({ kind, input, expected });
for (const state of ["OPEN", "CLOSED", "MERGED"]) {
  for (const reviewDecision of [null, "REVIEW_REQUIRED", "APPROVED", "CHANGES_REQUESTED"]) {
    const input = { ...pr, state, reviewDecision, stack: null, latestReviews: { nodes: [{ state: "CHANGES_REQUESTED", isMinimized: true, author: { login: "hidden" } }, { state: "APPROVED", isMinimized: false, author: { login: "bot[bot]" } }] } };
    const expected = pure.toPullRequestSummary(input);
    expected.author = avatar(expected.author);
    add("summary", input, expected);
  }
}
for (const login of ["nick", "bot[bot]", "a-b", "a_b", "-bad", "1", "x".repeat(40)]) {
  const input = { ...pr, author: { login, name: null, avatarUrl: null } };
  const expected = pure.toPullRequestSummary(input); expected.author = avatar(expected.author);
  add("summary", input, expected);
}
for (const conclusion of ["SUCCESS", "FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "CANCELLED", "SKIPPED", "NEUTRAL", "PENDING", "EXPECTED", null]) {
  const input = [ {name:"job",status:"COMPLETED",conclusion,workflowName:"CI",completedAt:"2026-11-16T00:00:00Z",isRequired:true}, {context:"external",state:"SUCCESS",targetUrl:"https://example.test/check"} ];
  add("checks", input, pure.pullRequestChecksFromContexts(input).checks);
}
add("checks", [
  {name:"job",status:"COMPLETED",conclusion:"FAILURE",workflowName:"CI",completedAt:"2026-11-15T00:00:00Z"},
  {name:"job",status:"IN_PROGRESS",workflowName:"CI"},
  {name:"job",status:"COMPLETED",conclusion:"SUCCESS",workflowName:"CI",completedAt:"2026-11-16T00:00:00Z"},
  {name:"job",status:"COMPLETED",conclusion:"CANCELLED",workflowName:"Other"},
], pure.pullRequestChecksFromContexts([
  {name:"job",status:"COMPLETED",conclusion:"FAILURE",workflowName:"CI",completedAt:"2026-11-15T00:00:00Z"},
  {name:"job",status:"IN_PROGRESS",workflowName:"CI"},
  {name:"job",status:"COMPLETED",conclusion:"SUCCESS",workflowName:"CI",completedAt:"2026-11-16T00:00:00Z"},
  {name:"job",status:"COMPLETED",conclusion:"CANCELLED",workflowName:"Other"},
]).checks);
for (const filename of ["src/app.rs", "src/app.test.ts", "src/Tests.swift", "src/Latest.java", "tests/a.rs", "tests/fixtures/a.rs", "a/README.md", "a/Cargo.lock", "foo.generated.ts", "a/__generated__/x", "foo_pb2.py", "foo.spec.tsx", "a\\__mocks__\\foo", "foo.snap", "mockData.ts", "mockery.ts", "requirements-dev.txt", "constraints.txt", "CMakeLists.txt", "robots.txt", "llms.txt", "foo.txt", "test_a.py", "conftest.py"]) {
  const input = {files:[{path:filename,additions:7,deletions:3}],truncated:false};
  add("breakdown", input, toChangeBreakdown(input));
}
add("breakdown", {files:[{path:"x.rs",additions:1,deletions:0}],truncated:true}, null);
for (const status of ["added","removed","renamed","modified"]) {
  for (const patch of ["", "@@ -1 +1 @@\n-a\n+b"]) {
    const input=[{filename:"new name.rs",previous_filename:"old\tname.rs",status,patch,additions:patch?1:0,deletions:patch?1:0}];
    const parsed=pure.decodePullRequestFilesJson(JSON.stringify(input));
    if (parsed._tag !== "Success") throw new Error("T3 patch fixture did not decode");
    const {rawCount,omittedFileStats,...expected}=parsed.success;
    expected.nextCursor=null;
    if (omittedFileStats.length) expected.omittedFileStats=omittedFileStats;
    add("patch",input,expected);
  }
}
const providerSource=fs.readFileSync(new URL("../../../../../packages/source-control-github/src/server/GitHubPullRequestProvider.ts",import.meta.url),"utf8");
const failureText = providerSource.slice(providerSource.indexOf("function gitHubProviderFailure("), providerSource.indexOf("\nfunction withAvatar("));
const classify = new Function("error", `${stripTypeScriptTypes(failureText)}\nreturn gitHubProviderFailure(error);`);
for (const [status, githubErrorTypes] of [
  [403, []], [503, []], [200, ["FORBIDDEN"]], [200, ["INTERNAL"]],
  [200, ["FORBIDDEN", "NOT_FOUND"]], [200, ["FORBIDDEN", "INTERNAL"]], [200, ["FORBIDDEN", null]],
]) {
  const input = { status, githubErrorTypes };
  add("provider-failure", input, classify({ _tag: "GitHubApiResponseError", ...input }).reason);
}
for (const credential of ["settings", "env", "gh"]) {
  add("access-hint", credential, classify({ _tag: "GitHubApiNotFoundError", credential }).accessHint);
}
for (const host of ["github.com", "github.example:8443", "localhost", "169.254.169.254", "169.254.1.2:443", "[fe80::1]", "user@github.com", "github.com/path"]) {
  add("github-host", host, isGitHubHost(host));
}
// `gh`'s pick of the repository a checkout's pull requests go to (`resolveRepository`).
const fetchLine = (name, url) => `${name}\t${url} (fetch)\n${name}\t${url} (push)\n`;
for (const [remotes, resolved, hostHint, defaultHost] of [
  [fetchLine("origin", "https://github.com/acme/web.git"), "", undefined, "github.com"],
  [fetchLine("fork", "https://github.com/me/web.git") + fetchLine("origin", "https://github.com/acme/web.git"), "", undefined, "github.com"],
  [fetchLine("origin", "https://github.com/me/web.git") + fetchLine("upstream", "https://github.com/acme/web.git"), "", undefined, "github.com"],
  [fetchLine("github", "git@github.com:acme/web.git") + fetchLine("origin", "https://github.com/me/web.git"), "", undefined, "github.com"],
  [fetchLine("a", "https://github.com/a/web.git") + fetchLine("b", "https://github.com/b/web.git"), "", undefined, "github.com"],
  [fetchLine("a", "https://github.com/a/web.git") + fetchLine("b", "https://github.com/b/web.git"), "remote.b.gh-resolved base\n", undefined, "github.com"],
  [fetchLine("a", "https://github.com/a/web.git") + fetchLine("b", "https://github.com/b/web.git"), "remote.a.gh-resolved Other/Repo\n", undefined, "github.com"],
  [fetchLine("a", "https://github.com/a/web.git") + fetchLine("b", "https://github.com/b/web.git"), "remote.a.gh-resolved base\nremote.b.gh-resolved base\n", undefined, "github.com"],
  [fetchLine("origin", "https://github.com/acme/web.git") + fetchLine("lab", "https://gitlab.com/acme/web.git"), "", undefined, "github.com"],
  [fetchLine("origin", "git@github.com-work:acme/web.git"), "", undefined, "github.com"],
  [fetchLine("origin", "git@github.com-work:acme/web.git"), "", "github.com-work", "github.com"],
  [fetchLine("origin", "https://github.example.com/acme/web.git"), "", undefined, "github.com"],
  [fetchLine("origin", "https://github.example.com:8443/acme/web.git"), "", undefined, "github.com"],
  [fetchLine("origin", "https://gitlab.com/acme/web.git"), "", undefined, "github.com"],
  [fetchLine("origin", "https://github.com/acme/group/web.git"), "", undefined, "github.com"],
  [fetchLine("origin", "github:acme/web.git"), "", undefined, "github.com"],
  ["", "", undefined, "github.com"],
  ["", "", "GitHub.Example.com", "github.example.com"],
  [fetchLine("origin", "https://github.com/acme/web.git") + fetchLine("upstream", "https://github.com/Acme/Web.git"), "", "github.com", "github.com"],
  ["origin\thttps://github.com/acme/web.git (fetch) [blob:none]\n", "", undefined, "github.com"],
]) {
  const input = { remotes, resolved, hostHint: hostHint ?? null, defaultHost };
  add("resolveRepository", input, resolveGitHubRepository({ remotes, resolved, hostHint, defaultHost }));
}
for (const [key,reason] of [["missing","cli-missing"],["unauthenticated","cli-unauthenticated"]]) {
  const match=new RegExp(key+':\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(providerSource);
  if (!match) throw new Error("T3 credential requirement changed shape: "+key);
  add("unavailable",reason,{_tag:"PullRequestUnavailableError",reason,provider:"github",requirement:JSON.parse('"'+match[1]+'"')});
}
for (const verdict of ["comment", "approve", "request-changes"]) {
  const input = { verdict, body: "  summary\n", comments: [] };
  add("reviewSubmission", input, pure.buildReviewSubmission(input));
}
const added = { kind: "added", newLine: 4 };
const deleted = { kind: "deleted", oldLine: 3 };
const left = { kind: "context", oldLine: 3, newLine: 4, side: "left" };
const right = { ...left, side: "right" };
for (const [position, startPosition] of [
  ...[added, deleted, left, right].map(position => [position, undefined]),
  [added, added],
  [added, { kind: "added", newLine: 1 }],
  [deleted, { kind: "deleted", oldLine: 1 }],
  [left, { ...left, oldLine: 1, newLine: 2 }],
  [right, { ...right, oldLine: 1, newLine: 2 }],
  [deleted, { kind: "added", newLine: 1 }],
]) {
  const input = { verdict: "comment", body: "  summary\n", comments: [{ path: "file.rs", body: "keep whitespace \n", position, ...(startPosition === undefined ? {} : { startPosition }) }] };
  add("reviewSubmission", input, pure.buildReviewSubmission(input));
}
for (const type of ["PullRequest","IssueComment","PullRequestReviewComment","PullRequestReview"]) {
  for (const actual of ["PR7","PR8",null]) {
    const field={IssueComment:"pullRequest",PullRequestReviewComment:"reviewCommentPullRequest",PullRequestReview:"reviewPullRequest"}[type];
    const input={repository:{pullRequest:{id:"PR7"}},node:{__typename:type,id:actual,...(field?{[field]:{id:actual}}:{})}};
    add("subject",input,pure.isSubjectOfPullRequest(input));
  }
}
add("subject",{repository:null,node:null},false);
const candidates={repository:{assignableUsers:{pageInfo:{hasNextPage:true},nodes:[{login:"author",name:null,avatarUrl:null},{login:"reviewer",name:"Reader",avatarUrl:null},{login:"new",name:null,avatarUrl:null},{login:"  ",name:null,avatarUrl:null}]},pullRequest:{author:{login:"author"},reviewRequests:{nodes:[{requestedReviewer:{login:"reviewer",name:"Reader",avatarUrl:null}},{requestedReviewer:{login:"outside",name:null,avatarUrl:null}},{requestedReviewer:{slug:"core",combinedSlug:"org/core",teamName:"Core",teamAvatarUrl:null}},{requestedReviewer:null}]}}}};
for(const query of [undefined,"","  ","new"]) {
  const input={result:candidates,...(query===undefined?{}:{query})};
  add("reviewerCandidates",input,pure.toReviewerCandidates(candidates,query));
}
for(const input of [[],[{id:"reader",kind:"user"},{id:"core",kind:"team"}]]) add("reviewerRequest",input,pure.buildReviewerRequest(input));
for(const input of [{repository:null},{repository:{labels:{nodes:[{name:"bug",color:"abc123",description:"  fix  "},{name:"bug",color:"def456",description:null},{name:" ",color:null,description:null}],pageInfo:{hasNextPage:true}},pullRequest:{labels:{nodes:[{name:"missing"},{name:"bug"}]}}}}]) add("labelCandidates",input,pure.toLabelCandidates(input));
for (const input of [[],[{number:1,url:"api-url",html_url:"  web-url ",base:{ref:"main"},pull_requests:[{number:7,head:{ref:"branch",sha:"abc"},title:"Change",draft:false,state:"closed",merged_at:"date"}]}],[{id:0,number:1,url:"url",base:"main",pull_requests:[]}]]) {
  const result=pure.decodePullRequestStacksJson(JSON.stringify(input));
  if(result._tag!=="Success") throw new Error("T3 stack fixture did not decode");
  add("stack",input,result.success);
}
for(const input of [null,{},[{number:"bad"}],...["title","draft","head"].map(key=>[{number:1,url:"url",base:"main",pull_requests:[{number:7,head:{ref:"branch"},[key]:key==="head"?{ref:"branch",sha:null}:null}]}])]) {
  add("stackError",input,pure.decodePullRequestStacksJson(JSON.stringify(input))._tag === "Failure");
}
for (const input of [
  "Plain body", "", "Body\n\nCo-authored-by: Claude <noreply@anthropic.com>",
  "Body\r\n\r\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\r\n",
  "Body\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n",
  "Body\n- Generated by Codex.\n* co-authored-by: Codex <CODEX@openai.com>",
  "Body\nCo-authored-by: Someone <noreply@github.com>\nCo-authored-by: GitHub Copilot <noreply@github.com>",
  "Body\n```\nCo-authored-by: Claude <noreply@anthropic.com>\n```\nCo-authored-by: Claude <noreply@anthropic.com>",
  "Body\n~~~\nGenerated with Claude\n~~~~\nGenerated with grok!",
  "Body\n``` js `x`\nGenerated with Cursor\n    Generated with Cursor\n\tGenerated with Cursor",
  "Generated with [Claude](https://claude.ai/x) by [link](https://example.com)",
  "generated with   opencode",
  "Generated with Claude Code please",
  "Co-authored-by: <noreply@anthropic.com>",
  "Body\n\n \t\n",
]) add("mergeMessage", input, removeAgentCredits(input));
for (const input of [
  "https://github.com/a/b/actions/runs/12/job/34", "https://github.com/a/b/actions/runs/12/jobs/34?pr=1",
  "https://github.com/a/b/runs/56", "https://github.com/a/b/runs/56#step", "https://github.com/a/b/actions/runs/12/job/34x",
  "https://github.com/a/b/c/runs/56", "http://github.com/a/b/runs/56", "https://ci.example.com/build/1", null,
  "https://x/runs/1/job/2/runs/3/job/4", "https://github.com/a/b/runs/",
]) add("jobId", input, gitHubActionsJobId(input));
for (const [text, lines] of [["a\nb\nc\n", 2], ["a\nb", 5], ["a\n\n", 5], ["", 1], ["x".repeat(40000), 1], ["é".repeat(33000) + "\nend", 1], ["😀".repeat(16001), 3]]) {
  add("logTail", { text, lines }, tailLogLines(text, lines));
}
for (const viewerPermission of ["WRITE", "admin", "READ", "TRIAGE", null, undefined]) {
  for (const pullRequest of [null, { viewerCanUpdate: false, viewerDidAuthor: true, headRepository: { viewerPermission: "READ" } }, { viewerCanUpdate: true, viewerDidAuthor: false, headRepository: null }, { viewerDidAuthor: false, headRepository: { viewerPermission: null } }]) {
    for (const autoMergeAllowed of [true, false]) {
      const input = { repository: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false, autoMergeAllowed, ...(viewerPermission === undefined ? {} : { viewerPermission }), pullRequest } };
      add("lightPermissions", input, gitHubViewerPermissions(pure.toViewerPermissions(input)));
    }
  }
}
add("lightPermissions", { repository: null }, null);
const lines = values => "[\n" + values.map(value => JSON.stringify(value)).join(",\n") + "\n]\n";
const out = lines(cases);
const actionPath = new URL("../src/pull_requests/action-cases.json", import.meta.url);
const actionCases = await recordActions();
const actionOut = lines(actionCases);
const guidePath = new URL("../../conn-server/src/methods/pull_requests/guide-fixture.json",import.meta.url);
const guideOut = JSON.stringify(await recordGuide())+"\n";
const runActionPath = new URL("../src/pull_requests/run-action-cases.json", import.meta.url);
const runActionCases = await recordRunActions();
const runActionOut = lines(runActionCases);
const issuePath = new URL("../src/pull_requests/issue-cases.json", import.meta.url);
const issueCases = await recordIssueTracker();
const issueOut = lines(issueCases);
const createPath = new URL("../src/pull_requests/create-cases.json", import.meta.url);
const createCases = await recordCreatePullRequests();
const createOut = lines(createCases);
const capabilitiesPath = new URL("../src/pull_requests/capabilities.json",import.meta.url);
const capabilitiesOut = JSON.stringify(await recordCapabilities())+"\n";
if (process.argv.includes("--check")) {
  if (fs.readFileSync(path,"utf8") !== out) throw new Error("PR characterizations changed; run gen-pr-cases.mjs and port the difference");
  if (fs.readFileSync(actionPath,"utf8") !== actionOut) throw new Error("PR action requests changed; run gen-pr-cases.mjs and port the difference");
  if (fs.readFileSync(guidePath,"utf8") !== guideOut) throw new Error("PR guide storage changed; run gen-pr-cases.mjs and port the difference");
  if (fs.readFileSync(runActionPath,"utf8") !== runActionOut) throw new Error("PR run-action and CI traces changed; run gen-pr-cases.mjs and port the difference");
  if (fs.readFileSync(issuePath,"utf8") !== issueOut) throw new Error("GitHub issue tracker traces changed; run gen-pr-cases.mjs and port the difference");
  if (fs.readFileSync(createPath,"utf8") !== createOut) throw new Error("T3's createPullRequest traces changed; run gen-pr-cases.mjs and port the difference");
  if (fs.readFileSync(capabilitiesPath,"utf8") !== capabilitiesOut) throw new Error("GitHub PR capabilities changed; run gen-pr-cases.mjs and port the difference");
  console.log(`PR characterizations: ${cases.length} T3 cases and ${actionCases.length} action traces current`);
} else { fs.writeFileSync(path,out); fs.writeFileSync(actionPath,actionOut); fs.writeFileSync(runActionPath,runActionOut); fs.writeFileSync(issuePath,issueOut); fs.writeFileSync(createPath,createOut); fs.writeFileSync(guidePath,guideOut); fs.writeFileSync(capabilitiesPath,capabilitiesOut); console.log(`recorded ${cases.length} PR characterizations, ${actionCases.length} API action traces, capabilities and T3's stored guide`); }
