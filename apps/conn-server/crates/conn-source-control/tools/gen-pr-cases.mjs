// Characterizations from T3's own normalization functions. No host CLI or network.
import * as fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { importSource } from "../../../tools/monorepo.mjs";
const pure = await importSource("packages/source-control-github/src/server/gitHubPullRequestJson.ts");
const { loginAvatarUrl } = await importSource("packages/source-control-github/src/server/GitHubPullRequestProvider.ts");
const { isGitHubHost } = await importSource("packages/source-control-github/src/server/GitHubCredentials.ts");
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
for (const [key,reason] of [["missing","cli-missing"],["unauthenticated","cli-unauthenticated"]]) {
  const match=new RegExp(key+':\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(providerSource);
  if (!match) throw new Error("T3 credential requirement changed shape: "+key);
  add("unavailable",reason,{_tag:"PullRequestUnavailableError",reason,provider:"github",requirement:JSON.parse('"'+match[1]+'"')});
}
const out = JSON.stringify(cases, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (fs.readFileSync(path,"utf8") !== out) throw new Error("PR characterizations changed; run gen-pr-cases.mjs and port the difference");
  console.log(`PR characterizations: ${cases.length} T3 cases current`);
} else { fs.writeFileSync(path,out); console.log(`recorded ${cases.length} PR characterizations`); }
