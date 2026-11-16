import { importSource, packageImporter } from "../../../tools/monorepo.mjs";

export async function recordPrLimits() {
  const pkg = packageImporter("packages/contracts");
  const [Schema,Exit,rpc] = await Promise.all([pkg("effect/Schema"),pkg("effect/Exit"),importSource("packages/contracts/src/rpc.ts")]);
  const ref={projectId:"p1",host:"github.com",repository:"a/b",number:7};
  const review={...ref,verdict:"comment",body:"review",comments:[{path:"file.rs",body:"line",position:{kind:"added",newLine:1}}]};
  const cases=[
    ["comment body over the limit","comment",{...ref,body:"x".repeat(65537)}],
    ["empty comment body","comment",{...ref,body:""}],
    ["blank comment body reaches service validation","comment",{...ref,body:" "}],
    ["title at the limit","update",{...ref,title:"x".repeat(1024)}],
    ["title over the limit","update",{...ref,title:"x".repeat(1025)}],
    ["empty title","update",{...ref,title:" "}],
    ["empty update body is allowed","update",{...ref,body:""}],
    ["update fields trim as the contract does","update",{...ref,projectId:" p1 ",repository:" a/b ",title:" new title "}],
    ["BOM is trimmed","update",{...ref,title:"\ufeff title \ufeff"}],
    ["NEXT LINE is kept","update",{...ref,title:"\u0085"}],
    ...[0,1,25,26].flatMap(count=>[
      [`reviewer count ${count}`,"requestReviewers",{...ref,reviewers:Array.from({length:count},()=>({id:"reader",kind:"user"})),requested:true}],
      [`label count ${count}`,"setLabels",{...ref,labels:Array.from({length:count},()=>"bug"),applied:true}],
    ]),
    ["blank label","setLabels",{...ref,labels:["  "],applied:true}],
    ["reviewer identifiers trim","requestReviewers",{...ref,reviewers:[{id:" reader ",kind:"user"}],requested:false}],
    ["added review position","submitReview",review],
    ["zero added review position","submitReview",{...review,comments:[{...review.comments[0],position:{kind:"added",newLine:0}}]}],
    ["zero deleted review position","submitReview",{...review,comments:[{...review.comments[0],position:{kind:"deleted",oldLine:0}}]}],
    ["context checks both line numbers","submitReview",{...review,comments:[{...review.comments[0],position:{kind:"context",oldLine:1,newLine:0,side:"left"}}]}],
    ["range start is positive","submitReview",{...review,comments:[{...review.comments[0],startPosition:{kind:"deleted",oldLine:0}}]}],
    ["blank reaction subject","setReaction",{...ref,subjectId:" ",content:"heart",reacted:true}],
    ["zero stack number","stack",{...ref,number:0}],
    ["blank guide project","reviewGuide",{...ref,projectId:" "}],
  ];
  return {cases:cases.map(([name,method,payload])=>{
    const tag=`pullRequests.${method}`;
    const schema=rpc.OfficialWsRpcGroup.requests.get(tag)?.payloadSchema;
    if(!schema) throw new Error(`No contract for ${tag}`);
    const result=Schema.decodeUnknownExit(schema)(payload);
    return {name,tag,payload,ok:Exit.isSuccess(result),...(Exit.isSuccess(result)?{after:result.value}:{})};
  })};
}
