import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importSource, packageImporter } from "../../../tools/monorepo.mjs";

export async function recordGuide() {
  const pkg = packageImporter("apps/server");
  const [Effect, Layer, Sqlite, Repository, Migration] = await Promise.all([
    pkg("effect/Effect"), pkg("effect/Layer"),
    importSource("packages/shared/src/nodeSqliteClient.ts"),
    importSource("apps/server/src/persistence/PullRequestReviewGuides.ts"),
    importSource("apps/server/src/persistence/Migrations/061_PullRequestReviewGuides.ts"),
  ]);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),"conn-pr-guide-recording-"));
  const filename = path.join(temp,"statev2.sqlite");
  try {
    const key = {host:"github.com",repository:"a/b",number:7};
    const guide = {
      headSha:"old-head",generatedAt:"2026-11-16T00:00:00Z",
      modelSelection:{instanceId:"codex",model:"gpt-6.1-sol",options:[{id:"reasoning_effort",value:"high"},{id:"fast",value:false}]},
      stops:[{title:"Read the boundary",summary:"Check the input.",attention:{kind:"contract",note:"Preserve the client contract."},
        excerpts:[{path:"src/main.rs",side:"new",start:1,end:4,caption:"Entry point"}],
        files:[{path:"src/main.rs",note:"Start here"}],notes:[{path:"src/main.rs",line:2,title:"Input",body:"Check malformed input."}],questions:["Does the error reach the client?"]}],
    };
    const program = Effect.gen(function*(){
      yield* Migration.default;
      const repository = yield* Repository.PullRequestReviewGuideRepository;
      yield* repository.put(key,guide);
      return yield* repository.get(key);
    });
    const layer = Repository.layer.pipe(Layer.provideMerge(Sqlite.layer({filename})));
    const result = await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));
    if(result._tag!=="Some") throw new Error("T3 did not read its stored guide");
    const database = new DatabaseSync(filename,{readOnly:true});
    try {
      return {key,guide:result.value,stored:database.prepare("SELECT guide_json FROM pull_request_review_guides").get().guide_json,schema:database.prepare("SELECT sql FROM sqlite_master WHERE name = 'pull_request_review_guides'").get().sql};
    } finally {database.close();}
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
}
