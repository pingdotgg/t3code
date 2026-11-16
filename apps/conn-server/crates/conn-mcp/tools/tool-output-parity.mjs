import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { importSource, monorepo } from "../../../tools/monorepo.mjs";
import { sealedEnv } from "../../../tools/sealed-env.mjs";

export async function toolOutputParity(binary) {
  const { T3_MCP_TOOL_NAMES, resolveT3McpToolId } = await importSource("packages/shared/src/t3McpToolPresentation.ts");
  const { compactDynamicToolOutput, htmlRenderFromToolItem, mcpAppFromToolItem, SEND_TO_USER_MAX_LENGTH } = await importSource("packages/shared/src/toolOutput.ts");
  const tests = FS.readFileSync(Path.join(monorepo(), "packages/shared/src/t3McpToolPresentation.test.ts"), "utf8");
  const prefixes = /for \(const prefix of \[([\s\S]*?)\]\)/.exec(tests)?.[1];
  if (!prefixes) throw new Error("T3 provider-prefix test moved");
  const strings = (source) => [...source.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]);
  const names = [...T3_MCP_TOOL_NAMES].flatMap((name) => [name, ...strings(prefixes).map((prefix) => `${prefix}${name} completed`), `mcp__another-server__${name}`]);
  const htmlTests = FS.readFileSync(Path.join(monorepo(), "packages/shared/src/htmlRender.test.ts"), "utf8");
  const htmlCases = htmlTests.split('describe("htmlRenderFromToolItem",')[1];
  if (!htmlCases) throw new Error("T3 HTML reference test moved");
  names.push(...[...htmlCases.matchAll(/\["([^"]+)",/g)].map((m) => m[1]));
  names.push("mcp__t3-code__other__html_render", "t3-code-direct__html_render", "mcp-_t3_code_html_render", "t3-code-thread_opencode2-adapter_delegate_task", "t3-code-thread_opencode2-adapter_not_a_tool", "HTML_render", "t3-code\u0085·html_render", "t3-code\ufeff·\ufeffhtml_render", "\ufeffmcp__t3-code__html_render", "\u0085html_render");
  const reference = { htmlRender: { attachmentId: "owner-00000000-0000-4000-8000-000000000001-html", title: " Page ", height: 100 } };
  const items = names.map((toolName) => ({ toolName, output: reference }));
  // Result envelopes and edge cases from toolOutput.test.ts and htmlRender.test.ts.
  const outputs = [reference, JSON.stringify(reference), {structuredContent:reference,content:"ignored"}, [{text:JSON.stringify(reference)}], {content:[{text:{text:JSON.stringify(reference)}}]}, {content:reference,is_error:true}, {content:reference,isError:true}, {content:reference,error:{}}, {_tag:"OrchestratorMcpFailure",content:reference}, [{text:JSON.stringify(reference)},{text:'{"isError":true}'}], [{text:"{}"},{text:JSON.stringify(reference)}],
    {threadId:"known",body:"x".repeat(20_000)}, {threadId:"thread-1",messageId:"message-1",response:"private"}, {thread:{threadId:"thread-1",messages:["private"]},taskId:"task-1",scheduledTaskId:"scheduled-1",linkedCount:2,unlinkedCount:1}, {threads:[{threadId:"created",status:"running"},{threadId:"reverted",status:"rolled_back"},{status:"rolled_back"}]}, {threads:[]}, {threadId:"reverted",status:"rolled_back"},
    ...["Draft:\n\n> Hi Sam,", "界".repeat(SEND_TO_USER_MAX_LENGTH), "界".repeat(SEND_TO_USER_MAX_LENGTH+1)].map((sentMessage)=>[{text:JSON.stringify({sentMessage})}]),
    ...[[{threadId:"known"},{title:"missing"}],Array.from({length:101},()=>({threadId:"known"})),Array.from({length:100},(_,i)=>({threadId:`${i}`.padEnd(256,"x")}))].map((threads)=>({threadId:"not-one",status:"rolled_back",taskId:"task-1",threads})),
    ...["x".repeat(20_000), JSON.stringify({threadId:"hidden",body:"😄".repeat(5000)}), Array.from({length:33},()=>({text:JSON.stringify(reference)})),{content:{content:{content:{content:{content:reference}}}}}].map((content)=>({isError:true,content})),
    ...[{height:"100"},{attachmentId:""},{attachmentId:"a".repeat(257)},{title:null},{height:5000,heights:[[728,99],[320,2]]}].map((patch)=>({htmlRender:{...reference.htmlRender,...patch}})),
    {t3McpApp:{attachmentId:"app",server:"server",tool:"tool",resourceUri:"ui://app",prefersBorder:false,csp:{connectDomains:["https://*.example.com","bad"]},permissions:{camera:{},microphone:[]}}},
  ];
  items.push(...outputs.map((output)=>({toolName:"html_render",output})));
  const app = {attachmentId:"app-html",server:"weather",tool:"show",resourceUri:"ui://weather",csp:{connectDomains:["https://example.com","*"]},permissions:{camera:{},microphone:true},private:"discard"};
  for (const toolName of ["weather.show","mcp__weather__show","other.tool"])
    for (const output of [{t3McpApp:app},{structuredContent:{t3McpApp:app}},{isError:true,content:[{text:JSON.stringify({t3McpApp:app})}]}]) items.push({toolName,output});
  const expected = items.map((item)=>({id:resolveT3McpToolId(item.toolName),compact:compactDynamicToolOutput(item.output)??null,html:htmlRenderFromToolItem(item)??null,app:mcpAppFromToolItem(item)??null}));
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "conn-tool-output-"));
  try {
    const result = spawnSync(binary, [], {input:JSON.stringify(items),encoding:"utf8",env:sealedEnv(root),maxBuffer:8*1024*1024});
    if (result.status !== 0) throw new Error(result.stderr || String(result.error));
    const actual = JSON.parse(result.stdout);
    if (actual.length !== expected.length) throw new Error("Tool-output case count changed");
    const canonical = (value) => JSON.stringify(value, (_,v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v);
    for (const [i,want] of expected.entries()) {
      if (canonical(actual[i]) !== canonical(want)) throw new Error(`tool-output case ${i} ${items[i].toolName}: ${canonical(actual[i])} != ${canonical(want)}`);
    }
    console.log(`tool-output: ${items.length} cases match T3 resolveT3McpToolId, compactDynamicToolOutput, htmlRenderFromToolItem and mcpAppFromToolItem`);
  } finally { FS.rmSync(root,{recursive:true,force:true}); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await toolOutputParity(process.argv[2]);
