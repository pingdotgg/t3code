import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {peerFixture} from "./peer-fixture.mjs";
import {gitEnv} from "../../../tools/sealed-env.mjs";

// Usage: audit-third.mjs <ts|rs> [replay_server]; the binary is the one under review.
const ts = process.argv[2] === "ts";
const binary = path.resolve(process.argv[3] ?? "target/debug/examples/replay_server");
if (!ts && !fs.existsSync(binary)) throw new Error(`no replay_server at ${binary}`);
const f = peerFixture(binary, "conn-third-");
async function run() {
  const s = ts ? await f.startTs("host",{script:fs.readFileSync(new URL("../../conn-provider-claude/testdata/cli/e01_turn.ndjson",import.meta.url),"utf8")}) : await f.startRust("host");
  const dir = path.join(f.root, "host");
  const cwd = path.join(dir, "project");
  const state = path.join(dir, ts ? "base/userdata" : "state");
  const git = (root, ...args) => execFileSync("git", ["-c","user.name=Probe","-c","user.email=p@example.invalid","-C",root,...args], {env:gitEnv(),encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  const raw = (tag, payload) => f.rpc(s, tag, payload);
  const rpc = async (tag, payload) => {
    const r = await raw(tag, payload);
    assert.equal(r._tag,"Success",tag+" "+JSON.stringify(r));
    return r.value;
  };
  const results = {};
  const file = (key, contents) => fs.writeFileSync(path.join(cwd,key),contents);
  // A registered, clean default branch and a one-commit-ahead local remote.
  const remote = path.join(dir,"origin.git"), producer=path.join(dir,"producer");
  git(cwd,"branch","-M","main");
  git(cwd,"init","-q","--bare","--initial-branch=main",remote);
  git(cwd,"remote","add","origin",remote);
  git(cwd,"push","-qu","origin","main");
  git(cwd,"remote","set-head","origin","main");
  git(dir,"clone","-q",remote,producer);
  fs.writeFileSync(path.join(producer,"upstream"),"from upstream\n");
  git(producer,"add","upstream"); git(producer,"commit","-qm","new head"); git(producer,"push","-q");
  const upstream = git(producer,"rev-parse","HEAD");
  await rpc("server.updateSettings",{patch:{automaticGitFetchInterval:0}});
  await rpc("vcs.refreshStatus",{cwd});
  results.fetchedWhileOff = git(cwd,"rev-parse","origin/main") === upstream;
  // Pin both tracking refs at the same commit; only the working branch is now behind.
  git(cwd,"fetch","-q","origin");
  await rpc("server.updateSettings",{patch:{automaticGitFetchInterval:30000,defaultAutoPull:true}});
  await rpc("vcs.refreshStatus",{cwd});
  results.autoPulled = git(cwd,"rev-parse","HEAD") === upstream;

  file("underlying.ts","export {};\n");
  fs.symlinkSync("underlying.ts",path.join(cwd,"alias.ts"));
  const whole = await rpc("projects.listEntries",{cwd});
  const folder = await rpc("projects.listEntries",{cwd,directoryPath:""});
  const search = await rpc("projects.searchEntries",{cwd,query:"alias.ts",limit:20});
  const hasAlias = r => r.entries.some(e => e.path==="alias.ts" && e.kind==="file");
  results.alias = [hasAlias(folder),hasAlias(whole),hasAlias(search)];
  file("large.txt","unmistakableNeedle\n"+"filler\n".repeat(610000));
  const query = await rpc("projects.searchContents",{cwd,query:"unmistakableNeedle",limit:10,caseSensitive:true,useRegex:false,wholeWord:false});
  results.largeText = [query.matches.length,query.truncated];
  fs.unlinkSync(path.join(cwd,"large.txt"));

  const logDir = path.join(state,"logs","terminals");
  fs.mkdirSync(logDir,{recursive:true});
  const threadId = "third-audit";
  fs.writeFileSync(path.join(logDir,"terminal_"+Buffer.from(threadId).toString("base64url")+".log"), "scrollback-from-T3\n");
  const terminal = {cwd,threadId,terminalId:"term-1"};
  const snap = await rpc("terminal.open",terminal);
  results.scrollback = snap.history.includes("scrollback-from-T3");
  const absent = await raw("terminal.open",{...terminal,terminalId:"absent",providerInstanceId:"unused-fixture-provider"});
  results.unknownProvider = absent._tag==="Success" ? "opened" : absent.cause[0].error._tag;
  await rpc("server.updateSettings",{patch:{providerInstances:{...(ts?{claudeAgent:{driver:"claudeAgent",enabled:true,config:{binaryPath:path.join(dir,"cli","claude")}}}:{}),fixtureprofile:{driver:"codex",enabled:true,config:{binaryPath:path.join(dir,"unused-stub")},environment:[{name:"AUDIT_PROFILE",value:"fixture-value",sensitive:false}]}}}});
  await rpc("terminal.open",{...terminal,terminalId:"profile",providerInstanceId:"fixtureprofile"});
  await rpc("terminal.write",{threadId,terminalId:"profile",data:'printf "%s\\n" "${AUDIT_PROFILE-unset}" > profile-value\r'});
  const mark = path.join(cwd,"profile-value");
  for(let i=0;i<100 && !fs.existsSync(mark);i++) await new Promise(r=>setTimeout(r,25));
  results.profile = fs.readFileSync(mark,"utf8").trim();
  await rpc("terminal.close",{threadId,deleteHistory:true});

  const managed = path.join(dir,"managed");
  await rpc("server.updateSettings",{patch:{worktreesDirectory:managed}});
  file("patterns","/*\n!/excluded/\n");
  fs.mkdirSync(path.join(cwd,"excluded"));
  file("excluded/asset","omitted by design\n");
  file("t3.json",JSON.stringify({worktreeSparsePatternsPath:"patterns"}));
  git(cwd,"add","patterns","excluded","t3.json","underlying.ts");
  git(cwd,"commit","-qm","sparse checkout");
  const create = async name => (await rpc("vcs.createWorktree",{cwd,refName:"HEAD",newRefName:name,path:null})).worktree.path;
  const sparse = await create("probe-sparse");
  results.excludedPresent = fs.existsSync(path.join(sparse,"excluded/asset"));
  const write = await raw("projects.writeFile",{cwd:sparse,relativePath:"audit.txt",contents:"probe"});
  results.managedWrite = write._tag==="Success" ? "saved" : write.cause[0].error.failure;

  const headers = {authorization:"Bearer "+s.bearer,"x-t3-orchestration-protocol":"2"};
  const shell = await fetch(s.origin+"/api/orchestration/shell",{headers}).then(r=>r.json());
  const projectId = shell.projects.find(p=>p.workspaceRoot===cwd).id;
  const launch = (name,workspaceStrategy) => rpc("orchestration.launchThread",{
    projectId,commandId:"audit-"+name,title:name,modelSelection:{instanceId:"claudeAgent",model:"claude-haiku-5-5"},
    runtimeMode:"auto",interactionMode:"default",workspaceStrategy,createdBy:"user",creationSource:"web",
  });
  const firstThreadItem = async (thread, afterSequence) => {
    const ticket = await fetch(s.origin+"/api/auth/websocket-ticket",{method:"POST",headers}).then(r=>r.json());
    const socket = new WebSocket(s.origin.replace(/^http/,"ws")+"/ws?orchestrationProtocol=2&wsTicket="+encodeURIComponent(ticket.ticket));
    let timer;
    try {
      return await new Promise((resolve,reject)=>{
        timer = setTimeout(()=>reject(Error("thread stream timed out")),10000);
        socket.onerror = ()=>reject(Error("thread stream failed"));
        socket.onopen = ()=>socket.send(JSON.stringify({_tag:"Request",id:"1",headers:[],tag:"orchestration.subscribeThread",
          payload:{threadId:thread,requestCompletionMarker:true,...(afterSequence===undefined?{}:{afterSequence})}}));
        socket.onmessage = ({data})=>{
          for(const line of String(data).split("\n").filter(Boolean)) {
            for(const frame of [JSON.parse(line)].flat()) {
              if(frame._tag==="Ping") socket.send(JSON.stringify({_tag:"Pong"}));
              if(String(frame.requestId)!=="1") continue;
              if(frame._tag==="Chunk") resolve(frame.values[0]);
              if(frame._tag==="Exit") resolve(frame.exit);
            }
          }
        };
      });
    } finally { clearTimeout(timer); socket.close(); }
  };
  const moved = await launch("diff-handoff",{type:"root"});
  const movedId = moved.threadId;
  const postCommand = payload => rpc("orchestration.dispatchCommand",{...payload,threadId:movedId});
  const finish = async ordinal => {
    await postCommand({type:"message.dispatch",commandId:"turn-"+ordinal,messageId:"message-"+ordinal,
      text:"Reply with exactly: pong",attachments:[],dispatchMode:{type:"start_immediately"},createdBy:"user",creationSource:"web"});
    const until = Date.now()+30000;
    do {
      const body = await fetch(s.origin+"/api/orchestration/threads/"+encodeURIComponent(movedId),{headers}).then(r=>r.json());
      const run = body.projection.runs.find(r=>r.ordinal===ordinal);
      if(run?.status==="failed") throw Error("fixture turn failed "+JSON.stringify(body.projection.turnItems.map(i=>[i.type,i.title,i.summary,i.text,i.error])).slice(-1500));
      if(run?.status==="completed" && body.projection.checkpoints.some(c=>c.appRunOrdinal===ordinal && c.status==="ready")) return;
      await new Promise(r=>setTimeout(r,50));
    } while(Date.now()<until);
    throw Error("fixture turn did not reach a ready checkpoint");
  };
  await finish(1);
  const handoff = path.join(dir,"handoff-checkout");
  git(cwd,"worktree","add","-qb","handoff",handoff,"HEAD");
  await postCommand({type:"thread.metadata.update",commandId:"handoff",branch:"handoff",worktreePath:handoff,expectedWorktreePath:null});
  file("old-only.txt","edit in the previous checkout\n");
  fs.writeFileSync(path.join(handoff,"new-only.txt"),"edit in the current checkout\n");
  await finish(2);
  const delta = await rpc("orchestration.getTurnDiff",{threadId:movedId,fromTurnCount:1,toTurnCount:2});
  results.checkpoint = [delta.diff.includes("new-only.txt"),delta.diff.includes("old-only.txt")];
  const cached = await launch("resume-delete",{type:"root"});
  const snapshot = await firstThreadItem(cached.threadId);
  assert.equal(snapshot.kind,"snapshot");
  await rpc("orchestration.dispatchCommand",{type:"thread.delete",threadId:cached.threadId,commandId:"delete-cached"});
  const resumed = await firstThreadItem(cached.threadId,snapshot.snapshotSequence);
  results.deleteOnResume = resumed.event?.type ?? resumed.cause?.[0]?.error?._tag ?? resumed.kind;
  const owned = await launch("restore",{type:"existing_worktree",branch:"probe-sparse",worktreePath:sparse});
  git(cwd,"worktree","remove","--force",sparse);
  assert.equal(fs.existsSync(sparse),false);
  const recovered = await raw("terminal.open",{threadId:owned.threadId,terminalId:"restore",cwd:sparse});
  results.restore = [recovered._tag,fs.existsSync(path.join(sparse,"underlying.ts"))];
  if(recovered._tag==="Success") await rpc("terminal.close",{threadId:owned.threadId,deleteHistory:true});

  file("t3.json","{}\n");
  const sub = path.join(dir,"child-repo");
  fs.mkdirSync(sub);
  git(sub,"init","-q");
  fs.writeFileSync(path.join(sub,"marker"),"submodule contents\n");
  git(sub,"add","marker");
  git(sub,"commit","-qm","module");
  // Permit only this fixture's local transport in its disposable home.
  fs.writeFileSync(path.join(dir,"home",".gitconfig"),'[protocol "file"]\n\tallow = always\n');
  git(cwd,"-c","protocol.file.allow=always","submodule","add","-q",sub,"module");
  git(cwd,"add","t3.json",".gitmodules","module");
  git(cwd,"commit","-qm","local submodule");
  const normal = await create("probe-submodules");
  results.moduleAvailable = fs.existsSync(path.join(normal,"module/marker"));
  await rpc("server.updateSettings",{patch:{worktreeSubmodules:"none"}});
  const noModules = await launch("no-modules",{type:"worktree",baseRef:"HEAD",branch:"probe-no-modules"});
  const deadline = Date.now()+20000;
  let launched;
  // T3 may return once it has accepted the launch and finish preparation asynchronously.
  do {
    const detail = await fetch(s.origin+"/api/orchestration/threads/"+encodeURIComponent(noModules.threadId),{headers}).then(r=>r.json());
    launched = detail.projection.thread.worktreePath;
    if(launched && fs.existsSync(path.join(launched,".gitmodules"))) break;
    await new Promise(r=>setTimeout(r,50));
  } while(Date.now()<deadline);
  assert.ok(launched && fs.existsSync(path.join(launched,".gitmodules")), JSON.stringify(noModules));
  results.modulePresentWhenOff = fs.existsSync(path.join(launched,"module/marker"));
  console.log(s.kind,JSON.stringify(results));
  assert.deepEqual(results, {
    checkpoint:[ts,!ts],deleteOnResume:ts?"thread.deleted":"OrchestrationV2GetThreadProjectionError",modulePresentWhenOff:!ts,
    fetchedWhileOff:!ts,autoPulled:ts,alias:[true,ts,ts],largeText:[ts?1:0,false],
    excludedPresent:!ts,moduleAvailable:ts,
    // Fixed in Conn as in T3: 3.2 instance environment, 3.6 restore, 3.7 managed save,
    // 3.8 T3 scrollback.
    unknownProvider:"TerminalProviderInstanceNotFoundError",profile:"fixture-value",
    restore:["Success",true],managedWrite:"saved",scrollback:true,
  });
}
run().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
