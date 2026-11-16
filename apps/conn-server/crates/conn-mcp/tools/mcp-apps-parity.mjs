// The real T3 App helpers and snapshot writer, compared with Rust on synthetic MCP data.
import * as fs from "node:fs";
import { createDriver } from "../../../helpers/sdk-host/drivers/claude.mjs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { importSource, inMonorepo, packageImporter } from "../../../tools/monorepo.mjs";
import { generateBootstrap } from "../../conn-files/tools/gen-mcp-apps.mjs";
import { captureMcpApps } from "../../../tools/capture-mcp-apps.mjs";
import { sealedEnv } from "../../../tools/sealed-env.mjs";

export async function checkMcpApps(binary) {
  captureMcpApps(true);
  const shared = await importSource("packages/shared/src/mcpApp.ts");
  generateBootstrap(shared, true);
  const { mcpAppFromToolItem } = await importSource("packages/shared/src/toolOutput.ts");
  const adapter = fs.readFileSync(inMonorepo("apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts"), "utf8");
  const functions = ["sendClaudeControlRequest", "claudeRulesMayCoverMcpTools", "claudeMcpToolForApps", "claudeMcpCallToolResult"];
  const source = functions.map((name) => {
    const match = new RegExp(`(?:async )?function ${name}\\b[\\s\\S]*?\\n}`).exec(adapter);
    if (!match) throw new Error(`T3 removed ${name}`);
    return match[0];
  }).join("\n");
  const upstream = Function("Predicate", `${stripTypeScriptTypes(source)}; return {${functions.join(",")}};`)({isObject: (v) => typeof v === "object" && v !== null});
  const driver = createDriver({describeError: (e) => ({message: String(e)})});
  const recorded = [];
  let permissionReply = {state:{rules:[]}};
  const query = {request: async (request) => {recorded.push(request); return {response:request.subtype === "mcp_call" ? {content:[]} : permissionReply};}};
  const call = {tool:"mcp__weather__show",arguments:{city:"Amsterdam"}};
  const callRequest = /sendClaudeControlRequest\(queryRuntime, (\{\s+subtype: "mcp_call",[\s\S]*?\n\s+\})\)/.exec(adapter);
  if (!callRequest) throw new Error("T3 changed its Claude MCP call shape");
  const expectedRequest = Function("call", `return (${callRequest[1]})`)(call);
  const expectedCall = await upstream.sendClaudeControlRequest(query, expectedRequest);
  const actualCall = await driver.call({state:{query}},"callMcpTool",[call]);
  if (!isDeepStrictEqual(expectedCall,actualCall) || !isDeepStrictEqual(recorded[0],recorded[1])) throw new Error("Claude MCP control request differs from T3");
  await driver.call({state:{query}},"listPermissionRules",[]);
  for (const reply of [{state:{rules:[],errors:["bad settings"]}},{state:{rules:[{behavior:"deny",rule:"*",notInEffect:"false"}]}},{state:{rules:[],errors:{}}}]) {
    permissionReply=reply;
    let failed=false;
    try {await driver.call({state:{query}},"listPermissionRules",[]);} catch {failed=true;}
    if (!failed) throw new Error("Unreadable Claude permission rules must fail closed");
  }
  const resolvers=[];
  const slow={query:{request:()=>new Promise((resolve)=>resolvers.push(resolve))}};
  const pending=Array.from({length:32},()=>driver.call({state:slow},"callMcpTool",[call]));
  let bounded=false;
  try {await driver.call({state:slow},"callMcpTool",[call]);} catch {bounded=true;}
  if (!bounded) throw new Error("SDK App calls must stay bounded while the server waits");
  for (const resolve of resolvers) resolve({response:{content:[]}});
  await Promise.all(pending);
  if (slow.mcpRequests !== 0) throw new Error("Completed App calls retained their slots");
  console.log("ok Claude SDK MCP forwarding matches T3; malformed rules fail closed");
  const cases = [];
  const expected = [];
  const add = (input, result) => { cases.push(input); expected.push(result ?? null); };
  for (const meta of [{}, null, {ui:{visibility:["app"]}}, {ui:{visibility:["model"]}}, {ui:{visibility:[]}}, {ui:{visibility:"app"}}]) add({kind:"visibility",meta}, shared.mcpAppToolCallableByApp(meta));
  const reference = {attachmentId:"file-html",server:"weather",tool:"get.weather",resourceUri:"ui://weather"};
  const unicodeReference = {attachmentId:"file-html",server:"weather🌦",tool:"show🌤",resourceUri:"ui://weather"};
  const unicodeItem = {type:"dynamic_tool",toolName:shared.claudeMcpToolName(unicodeReference.server,unicodeReference.tool),output:{t3McpApp:unicodeReference}};
  add({kind:"reference",item:unicodeItem},mcpAppFromToolItem(unicodeItem));
  for (const name of ["weather.get.weather", "mcp__weather__get_weather", "other.tool"])
    for (const output of [{t3McpApp:reference}, JSON.stringify({t3McpApp:reference})]) {
      const item = {type:"dynamic_tool",toolName:name,output};
      add({kind:"reference",item},mcpAppFromToolItem(item));
    }
  for (const output of [
    {structuredContent:{t3McpApp:reference}},
    {content:[{type:"text",text:JSON.stringify({t3McpApp:reference})}]},
    {isError:true,structuredContent:{t3McpApp:reference}},
    {structuredContent:{},content:[{text:JSON.stringify({t3McpApp:reference})}]},
    {content:[{text:"x".repeat(16385)},{text:JSON.stringify({t3McpApp:reference})}]},
    {content:Array.from({length:33},()=>({text:JSON.stringify({t3McpApp:reference})}))},
    JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify({t3McpApp:reference}))))),
  ]) {
    const item={type:"dynamic_tool",toolName:"mcp__weather__get_weather",status:"failed",output};
    add({kind:"reference",item},mcpAppFromToolItem(item));
  }
  const untrusted = {...reference,private:"discard",csp:{connectDomains:["*","https://example.com","https://bad/path"]},permissions:{camera:true,microphone:{}}};
  for (const output of [{t3McpApp:untrusted},{isError:true,content:[{text:JSON.stringify({t3McpApp:untrusted})}]}]) {
    const item={type:"dynamic_tool",toolName:"weather.get.weather",output};
    add({kind:"reference",item},mcpAppFromToolItem(item));
  }
  for (const rules of [null,[],[{behavior:"ask",rule:"mcp__other__tool"}],[{behavior:"deny",rule:"*"}],[{behavior:"deny",rule:"mcp__alias(*)",notInEffect:true}]]) {
    const tool = {name:"refresh",description:"Refresh",_meta:{ui:{visibility:["app"]}},annotations:{readOnly:true,destructive:false,openWorld:true}};
    add({kind:"tool",tool,rules},upstream.claudeMcpToolForApps(tool,rules));
  }
  for (const value of ["plain text",{content:"flattened"},{content:[{type:"text",text:"ok"}],structuredContent:{ok:true},isError:false,_meta:{stub:true}},{content:[],isError:true},null]) add({kind:"call",value},upstream.claudeMcpCallToolResult(value));
  const load = packageImporter("apps/server");
  const Effect = await load("effect/Effect");
  const { NodeFileSystem } = await load("@effect/platform-node");
  const { snapshotMcpApp } = await importSource("apps/server/src/mcpApps/McpAppSnapshot.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"conn-mcp-app-parity-"));
  try {
    const contents = [
      [{uri:"ui://app",mimeType:"text/html;profile=mcp-app",text:"<!doctype html><h1>App</h1>",_meta:{ui:{csp:{connectDomains:["https://example.com","*","https://bad/path"],resourceDomains:["https://*.example.com"]},permissions:{camera:{}},prefersBorder:true}}}],
      [{mimeType:"text/html;profile=mcp-app",blob:Buffer.from("<h1>blob</h1>").toString("base64")}],
      [{uri:"ui://other",mimeType:"text/html;profile=mcp-app",text:"<h1>Other</h1>"}],
      [{mimeType:"text/plain",text:"plain"}],
    ];
    for (const content of contents) {
      const ref = await Effect.runPromise(snapshotMcpApp({attachmentsDir:dir,threadId:"thread",server:"server",tool:"tool",resourceUri:"ui://app",contents:content}).pipe(Effect.provide(NodeFileSystem.layer)));
      let result;
      if (ref) { const {attachmentId,...reference}=ref; result={reference,html:fs.readFileSync(path.join(dir,`${attachmentId}.html`),"utf8")}; }
      add({kind:"snapshot",contents:content},result);
    }
    for (const html of ["<h1>App</h1>","<!doctype html><h1>App</h1>",shared.injectMcpAppCsp("<!doctype html><h1>App</h1>",{connectDomains:["https://example.com"]})]) add({kind:"bootstrap",html},shared.injectMcpAppCookieBootstrap(shared.injectMcpAppThemeBootstrap(html)));
    const run = spawnSync(binary,["--state-dir",path.join(dir,"rust")],{input:JSON.stringify(cases),encoding:"utf8",env:sealedEnv(dir)});
    if (run.status !== 0) throw new Error(`MCP App differential runner: ${run.stderr}`);
    const actual = JSON.parse(run.stdout);
    for (const [index,result] of expected.entries()) if (!isDeepStrictEqual(actual[index],result)) throw new Error(`MCP App parity ${index}: ${JSON.stringify(cases[index])}\nRust ${JSON.stringify(actual[index])}\nT3 ${JSON.stringify(result)}`);
    console.log(`ok MCP App parity: ${cases.length} source, visibility, rules, result and document cases`);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
