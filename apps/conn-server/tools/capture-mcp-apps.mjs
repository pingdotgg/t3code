// Record the inputs of T3's own MCP App adapter tests. No CLI or model runs.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { inMonorepo, repoRoot } from "./monorepo.mjs";
import { sealedNodeEnv } from "./sealed-env.mjs";

export function captureMcpApps(check = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conn-app-recording-"));
  try {
    for (const [provider,forged] of [["Claude",false],["Claude",true],["Codex",false]]) {
      const adapters = inMonorepo("apps/server/src/orchestration-v2/Adapters");
      const copy = path.join(adapters, `Conn${provider}App.${process.pid}.tmp.test.ts`);
      const output = path.join(dir, `${provider}.json`);
      let source = fs.readFileSync(path.join(adapters, `${provider}AdapterV2.test.ts`), "utf8");
      let title;
      if (provider === "Claude") {
        source = source.replace("function claudeSdkFrame(frame: unknown): SDKMessage {", "const connAppFrames: unknown[] = [];\n  function claudeSdkFrame(frame: unknown): SDKMessage {\n    connAppFrames.push(frame);");
        source = source.replace("const mcpRequests: Array<unknown> = [];", "connAppFrames.length = 0;\n    const mcpRequests: Array<unknown> = [];");
        source = source.replace("return { harness, item: item!, mcpRequests };", `connWrite(${JSON.stringify(output)}, JSON.stringify({frames:connAppFrames, status:PROBE_SERVER_STATUS, ...(${forged} ? {output:item!.output} : {})}, null, 2) + "\\n");\n    return { harness, item: item!, mcpRequests };`);
        title = forged ? "keeps a plain MCP tool row when its own output carries an app reference" : "renders a Claude MCP tool's ui:// resource as an app and serves its tool calls";
      } else {
        const marker = 'const item = yield* Deferred.await(appCaptured);';
        const start = source.indexOf('it.effect("captures the app of a tool call that defers to its form"');
        if (start < 0) throw new Error("T3 removed the deferred App test");
        source = source.slice(0, start) + source.slice(start).replace(marker, `${marker}\n      connWrite(${JSON.stringify(output)}, JSON.stringify({transcript:mcpAppDeferredTranscript, result:item.type === "dynamic_tool" ? (item.output as {result:unknown}).result : null}, null, 2) + "\\n");`);
        title = "captures the app of a tool call that defers to its form";
      }
      try {
        fs.writeFileSync(copy, `import ${JSON.stringify(path.join(repoRoot, "tools/no-outside-fetch.mjs"))};\nimport {writeFileSync as connWrite} from "node:fs";\n${source}`);
        const run = spawnSync(process.execPath, [inMonorepo("node_modules/vite-plus/bin/vp"), "test", "run", path.relative(inMonorepo("apps/server"), copy), "-t", title], {cwd:inMonorepo("apps/server"), env:sealedNodeEnv(dir), encoding:"utf8", maxBuffer:8*1024*1024});
        if (run.status !== 0) throw new Error(`${provider} T3 App recording failed:\n${run.stdout}\n${run.stderr}`);
        const recording = JSON.parse(fs.readFileSync(output, "utf8"));
        const target = path.join(repoRoot, `crates/conn-provider-${provider.toLowerCase()}/testdata/mcp-app${forged ? "-forged" : ""}.json`);
        if (check) {
          if (!isDeepStrictEqual(recording, JSON.parse(fs.readFileSync(target, "utf8")))) throw new Error(`${target} drifted; run node tools/capture-mcp-apps.mjs`);
        } else fs.writeFileSync(target, JSON.stringify(recording, null, 2) + "\n");
        console.log(`ok ${provider} MCP App inputs recorded from T3's adapter test`);
      } finally {fs.rmSync(copy, {force:true});}
    }
  } finally {fs.rmSync(dir, {recursive:true,force:true});}
}

if (process.argv[1] === new URL(import.meta.url).pathname) captureMcpApps(process.argv.includes("--check"));
