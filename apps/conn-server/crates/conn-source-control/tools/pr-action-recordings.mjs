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
