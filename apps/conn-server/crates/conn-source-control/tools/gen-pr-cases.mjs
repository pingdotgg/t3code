// Characterizations from T3's own normalization functions. No host CLI or network.
import * as fs from "node:fs";
import { importSource } from "../../../tools/monorepo.mjs";
import { recordActions, recordCapabilities } from "./pr-action-recordings.mjs";
import { recordGuide } from "../../conn-server/tools/pr-guide-recordings.mjs";
const pure = await importSource("packages/source-control-github/src/server/gitHubPullRequestJson.ts");
const { loginAvatarUrl } = await importSource("packages/source-control-github/src/server/GitHubPullRequestProvider.ts");
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
for (const [key,reason] of [["missing","cli-missing"],["unauthenticated","cli-unauthenticated"]]) {
  const match=new RegExp(key+':\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(providerSource);
  if (!match) throw new Error("T3 credential requirement changed shape: "+key);
  add("unavailable",reason,{_tag:"PullRequestUnavailableError",reason,provider:"github",requirement:JSON.parse('"'+match[1]+'"')});
}
for (const verdict of ["comment", "approve", "request-changes"]) {
  for (const position of [{kind:"added",newLine:4},{kind:"deleted",oldLine:3},{kind:"context",oldLine:3,newLine:4,side:"left"},{kind:"context",oldLine:3,newLine:4,side:"right"}]) {
    for (const startPosition of [undefined, position, {kind:"added",newLine:1}]) {
      const input={verdict,body:"  summary\n",comments:[{path:"file.rs",body:"keep whitespace \n",position,...(startPosition===undefined?{}:{startPosition})}]};
      add("reviewSubmission",input,pure.buildReviewSubmission(input));
    }
  }
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
const out = JSON.stringify(cases, null, 2) + "\n";
const actionPath = new URL("../src/pull_requests/action-cases.json", import.meta.url);
const actionCases = await recordActions();
const actionOut = JSON.stringify(actionCases,null,2)+"\n";
const guidePath = new URL("../../conn-server/src/methods/pull_requests/guide-fixture.json",import.meta.url);
const guideOut = JSON.stringify(await recordGuide(),null,2)+"\n";
const capabilitiesPath = new URL("../src/pull_requests/capabilities.json",import.meta.url);
const capabilitiesOut = JSON.stringify(await recordCapabilities(),null,2)+"\n";
if (process.argv.includes("--check")) {
  if (fs.readFileSync(path,"utf8") !== out) throw new Error("PR characterizations changed; run gen-pr-cases.mjs and port the difference");
  if (fs.readFileSync(actionPath,"utf8") !== actionOut) throw new Error("PR action requests changed; run gen-pr-cases.mjs and port the difference");
  if (fs.readFileSync(guidePath,"utf8") !== guideOut) throw new Error("PR guide storage changed; run gen-pr-cases.mjs and port the difference");
  if (fs.readFileSync(capabilitiesPath,"utf8") !== capabilitiesOut) throw new Error("GitHub PR capabilities changed; run gen-pr-cases.mjs and port the difference");
  console.log(`PR characterizations: ${cases.length} T3 cases and ${actionCases.length} action traces current`);
} else { fs.writeFileSync(path,out); fs.writeFileSync(actionPath,actionOut); fs.writeFileSync(guidePath,guideOut); fs.writeFileSync(capabilitiesPath,capabilitiesOut); console.log(`recorded ${cases.length} PR characterizations, ${actionCases.length} API action traces, capabilities and T3's stored guide`); }
