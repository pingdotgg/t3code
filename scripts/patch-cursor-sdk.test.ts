import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";
import * as TestConsole from "effect/testing/TestConsole";
import ts from "typescript-legacy";

import {
  CursorSdkPatchError,
  applyTextEdits,
  assertValidSyntax,
  collectAgentDtsResumeEdits,
  collectAttributionForwardingEdits,
  collectAttributionResourceFactoryEdits,
  collectLocalAgentResumeMethodEdits,
  collectModelListCacheRetryEdits,
  collectResumeActionDispatchEdits,
  collectShellStreamOutputEdits,
  findResumeActionClassInBundle,
  findResumeActionExportInWebpackModule,
  generateUnifiedPatch,
  parseSource,
  patchCursorSdkCommand,
  patchCursorSdkPackage,
} from "./patch-cursor-sdk.ts";

const ScriptTestLayer = Layer.mergeAll(NodeServices.layer, TestConsole.layer);
const runCli = Command.runWith(patchCursorSdkCommand, { version: "0.0.0" });
const isCursorSdkPatchError = Schema.is(CursorSdkPatchError);

const MINIMAL_AGENT_DTS = `export interface SDKAgent {
    readonly agentId: string;
    summarize(): Promise<Run>;
}
`;

function makeWebpackIndexFixture(
  ids = { resumeClass: "Qa1", resumeKey: "rKey", summarizeClass: "Sa1", summarizeKey: "sKey" },
) {
  return `export const __webpack_esm_modules__={"../proto/dist/generated/agent/v1/agent_pb.js"(t,r,e){e.d(r,{${ids.resumeKey}:()=>${ids.resumeClass},${ids.summarizeKey}:()=>${ids.summarizeClass}});class ${ids.resumeClass}{static $(){return["ResumeAction|2 request_context #0"]}}class ${ids.summarizeClass}{static $(){return["SummarizeAction"]}}},"./src/agent/local.ts"(t,r,e){class LocalAgent{async summarize(){try{const a=await this.platform.store.getAgent(this.agentId);if(null===a)throw new ErrNotFound(\`Agent \${this.agentId} not found\`,{isRetryable:!1});if(null===a.latestCheckpointRef)throw new ErrCfg(\`Agent \${this.agentId} has no saved conversation to summarize yet.\`,{isRetryable:!1});return await this.sendImpl({summarize:!0},{},(()=>{}))}catch(a){const b=(0,ErrMod.wrap)(a,{operation:"agent.summarize"});throw(0,TelMod.track)({apiKey:this.options.apiKey,operation:"agent.summarize",runtime:"local",error:b}),b}}}class Platform{constructor(){this.localModelListCache=new Map}async resolveLocalModelSelection(sel,key,team){const trimmed=key?.trim();return resolveHelper(sel,{listModels:void 0!==trimmed&&trimmed.length>0?()=>this.listModelsForLocalValidation(trimmed,team):void 0})}async listModelsForLocalValidation(key,team){const cacheKey=JSON.stringify([key,team??null]);let entry=this.localModelListCache.get(cacheKey);void 0===entry&&(entry=fetchModels(key,team),this.localModelListCache.set(cacheKey,entry));try{return await entry}catch(err){throw this.localModelListCache.delete(cacheKey),err}}}}};`;
}

function makeWebpackChunkFixture(ids = { summarizeKey: "sKey", protoNs: "pb" }) {
  return `export const __webpack_esm_modules__={"./src/agent/local-executor.ts"(e,t,r){class StreamHandler{handle(ctx,req){const parsed=this.deserializeArgs(req);if(void 0===parsed)return;const{id:callId,args:callArgs}=parsed;return async function*(self){const t0=performance.now(),hooks=[],stream=self.exec.execute(ctx,callArgs,{execId:req.execId,hookContextCollector:hooks,deliverAgentStoreConflictNotices:!0===req.acceptHookAdditionalContexts});try{for await(const chunk of stream){const msg=self.serializeStream(callId,chunk);msg.localExecutionTimeMs=Math.round(Math.max(0,performance.now()-t0)),yield msg}}finally{}}(this)}}function makeRes(opts,ws){return{mcpFileOutputThresholdBytes:opts.mcpFileOutputThresholdBytes,mcpMetaToolEnabled:opts.mcpMetaToolEnabled,getAgentSkills:ws.getAgentSkills}}function buildAdapters(srcSet){return{...ok?{localExtensibility:mkExt({includeProjectExtensibility:hasSrc(srcSet,"project"),includeUserExtensibility:hasSrc(srcSet,"user")})}:{},resourceFactory:mkFactory({ignoreService:1,grepProvider:2,workspacePaths:3,diagnosticsProvider:4,repositoryProvider:5})}}function buildAction(input){return!0===input.summarize?new ${ids.protoNs}.Act({action:{case:"summarizeAction",value:new ${ids.protoNs}.${ids.summarizeKey}}}):new ${ids.protoNs}.Act({action:{case:"userMessageAction",value:new ${ids.protoNs}.Usr({})}})}}};`;
}

function makeBundledFixture() {
  return [
    `var RAct = class RAct { static $(){ return ["ResumeAction|2 request_context #0"]; } };`,
    `var SAct = class SAct { static $(){ return ["SummarizeAction"]; } };`,
    `class StreamH { handle(ctx, req) { let parsed = this.deserializeArgs(req); if (parsed === void 0) return; let { id: cid, args: cargs } = parsed; async function* run(self) { let t0 = performance.now(), stream = self.exec.execute(ctx, cargs); try { for await (let ev of stream) { let out = self.serializeStream(cid, ev); yield out; } } finally {} } return run(this); } }`,
    `function mkOpts($o, $ws) { return { mcpFileOutputThresholdBytes: $o.mcpFileOutputThresholdBytes, mcpMetaToolEnabled: $o.mcpMetaToolEnabled, getAgentSkills: $ws.getAgentSkills }; }`,
    `function mkAdapters($s) { return { ...flag ? { localExtensibility: ext({ includeUserExtensibility: chk($s, "user") }) } : {}, resourceFactory: fac({ ignoreService: 1, grepProvider: 2, workspacePaths: 3, diagnosticsProvider: 4, repositoryProvider: 5 }) }; }`,
    `function mkAct($in) { return $in.summarize === !0 ? new ActionWrap({ action: { case: "summarizeAction", value: new SAct } }) : new ActionWrap({ action: { case: "userMessageAction", value: new UAct } }); }`,
    `class CloudAgent { async summarize() { throw new Error("summarize() is only supported for local SDK agents."); } }`,
    `class LocalAgent { async summarize() { try { let rec = await this.platform.store.getAgent(this.agentId); if (rec === null) throw new NF(\`Agent \${this.agentId} not found\`, { isRetryable: !1 }); if (rec.latestCheckpointRef === null) throw new CF(\`Agent \${this.agentId} has no saved conversation to summarize yet.\`, { isRetryable: !1 }); return await this.sendImpl({ summarize: !0 }, {}, () => {}); } catch (err) { let wrapped = wrapErr(err, { operation: "agent.summarize" }); throw trackErr({ apiKey: this.options.apiKey, operation: "agent.summarize", runtime: "local", error: wrapped }), wrapped; } } }`,
    `class Plat { localModelListCache = new Map; async resolveLocalModelSelection($m, $k, $t) { let $tk = $k?.trim(); return resolveM($m, { listModels: $tk !== void 0 && $tk.length > 0 ? () => this.listModelsForLocalValidation($tk, $t) : void 0 }); } async listModelsForLocalValidation($k, $t) { let $ck = JSON.stringify([$k, $t ?? null]), $ent = this.localModelListCache.get($ck); if ($ent === void 0) $ent = fetchModels($k, $t), this.localModelListCache.set($ck, $ent); try { return await $ent; } catch ($e) { throw this.localModelListCache.delete($ck), $e; } } }`,
  ].join("\n");
}

describe("patch-cursor-sdk AST transforms", () => {
  it("forwards shell stdout/stderr regardless of minified identifier names", async () => {
    const src = `class Handler {
      constructor(exec, deserializeArgs, serializeStream) {
        this.exec = exec; this.deserializeArgs = deserializeArgs; this.serializeStream = serializeStream;
      }
      handle(ctx, req) {
        const dec = this.deserializeArgs(req);
        if (dec === void 0) return;
        const { id: myId, args: myArgs } = dec;
        return async function*(self) {
          for await (let myChunk of self.exec.execute(ctx, myArgs)) {
            yield self.serializeStream(myId, myChunk);
          }
        }(this);
      }
    }`;
    const sf = parseSource(src, "chunk.js");
    const edits = collectShellStreamOutputEdits(sf);
    assert.equal(edits.length, 1);
    const patched = applyTextEdits(src, edits);
    assertValidSyntax(patched, "chunk.js");

    const received: Array<unknown> = [];
    const sym = Symbol.for("@cursor/sdk.shellStreamOutput");
    const prev = Reflect.get(globalThis, sym);
    Reflect.set(globalThis, sym, (payload: unknown) => received.push(payload));
    try {
      const HandlerCtor = new Function(`${patched}; return Handler;`)();
      const handler = new HandlerCtor(
        {
          async *execute() {
            yield { event: { case: "stdout", value: { data: "hello\n" } } };
            yield { event: { case: "exit", value: { code: 0 } } };
            yield { event: { case: "stderr", value: { data: "warn\n" } } };
          },
        },
        () => ({ id: "id-1", args: { conversationId: "conv-1", toolCallId: "tool-1" } }),
        (id: string, chunk: unknown) => ({ id, chunk }),
      );
      const yielded: Array<unknown> = [];
      for await (const item of handler.handle({}, {})) {
        yielded.push(item);
      }
      assert.equal(yielded.length, 3);
      assert.deepStrictEqual(received, [
        {
          conversationId: "conv-1",
          toolCallId: "tool-1",
          event: { case: "stdout", value: { data: "hello\n" } },
        },
        {
          conversationId: "conv-1",
          toolCallId: "tool-1",
          event: { case: "stderr", value: { data: "warn\n" } },
        },
      ]);
    } finally {
      if (prev === undefined) {
        Reflect.deleteProperty(globalThis, sym);
      } else {
        Reflect.set(globalThis, sym, prev);
      }
    }
  });

  it("injects attributionConfigProvider forwarding and resourceFactory provider, and rejects already-patched input", () => {
    const src = makeWebpackChunkFixture();
    const sf = parseSource(src, "chunk.js");
    const fwdEdits = collectAttributionForwardingEdits(sf);
    const factoryEdits = collectAttributionResourceFactoryEdits(sf);
    assert.equal(fwdEdits.length, 1);
    assert.equal(factoryEdits.length, 1);

    const patched = applyTextEdits(src, [...fwdEdits, ...factoryEdits]);
    assertValidSyntax(patched, "chunk.js");
    assert.include(patched, "attributionConfigProvider:opts.attributionConfigProvider");
    assert.include(patched, 'attributionConfigProvider:hasSrc(srcSet,"user")?{get(){');

    const patchedSf = parseSource(patched, "chunk.js");
    assert.throws(() => collectAttributionForwardingEdits(patchedSf), /already forward/);
    assert.throws(() => collectAttributionResourceFactoryEdits(patchedSf), /already sets/);
  });

  it("resolves renamed ResumeAction/SummarizeAction exports and dispatches resumeAction", () => {
    const idxSf = parseSource(
      makeWebpackIndexFixture({
        resumeClass: "CustomResume",
        resumeKey: "zRes",
        summarizeClass: "CustomSummarize",
        summarizeKey: "zSum",
      }),
      "index.js",
    );
    const resolved = findResumeActionExportInWebpackModule(idxSf);
    assert.deepStrictEqual(resolved, { resumeExportKey: "zRes", summarizeExportKey: "zSum" });

    const chunkSrc = makeWebpackChunkFixture({ summarizeKey: "zSum", protoNs: "protoMod" });
    const chunkSf = parseSource(chunkSrc, "chunk.js");
    const edits = collectResumeActionDispatchEdits(
      chunkSf,
      { kind: "member", exportKey: resolved.summarizeExportKey },
      { kind: "member", exportKey: resolved.resumeExportKey },
    );
    assert.equal(edits.length, 1);
    const patched = applyTextEdits(chunkSrc, edits);
    assertValidSyntax(patched, "chunk.js");
    assert.include(
      patched,
      'input.resume===!0?new protoMod.Act({action:{case:"resumeAction",value:new protoMod.zRes}}):',
    );
  });

  it("clones local async summarize() into resume(__t3o={}) while skipping cloud summarize()", async () => {
    const src = makeBundledFixture();
    const sf = parseSource(src, "bundled.js");
    const edits = collectLocalAgentResumeMethodEdits(sf);
    assert.equal(edits.length, 1);
    const patched = applyTextEdits(src, edits);
    assertValidSyntax(patched, "bundled.js");

    const sendCalls: Array<ReadonlyArray<unknown>> = [];
    const LocalAgentCtor = new Function(
      "NF",
      "CF",
      "wrapErr",
      "trackErr",
      `${patched}; return LocalAgent;`,
    )(
      Error,
      Error,
      (e: unknown) => e,
      () => {},
    );
    const agent = new LocalAgentCtor();
    agent.agentId = "agent-42";
    agent.options = { apiKey: "k" };
    agent.platform = { store: { getAgent: async () => ({ latestCheckpointRef: "ref-1" }) } };
    agent.sendImpl = async (...args: ReadonlyArray<unknown>) => {
      sendCalls.push(args);
      return "run-ok";
    };

    const res = await agent.resume({ mode: "plan" });
    assert.equal(res, "run-ok");
    assert.deepStrictEqual(sendCalls[0]?.slice(0, 2), [
      { text: "", resume: true },
      { mode: "plan" },
    ]);

    // Rejects when resume() already exists
    const patchedSf = parseSource(patched, "bundled.js");
    assert.throws(() => collectLocalAgentResumeMethodEdits(patchedSf), /already defines resume/);
  });

  it("retries model list validation once on stale cache miss without looping on fresh miss", async () => {
    for (const [label, fixture] of [
      ["webpack", makeWebpackIndexFixture()],
      ["bundled", makeBundledFixture()],
    ] as const) {
      const sf = parseSource(fixture, `${label}.js`);
      const edits = collectModelListCacheRetryEdits(sf);
      const patched = applyTextEdits(fixture, edits);
      assertValidSyntax(patched, `${label}.js`);

      let fetchCount = 0;
      const models: Array<{ id: string; aliases?: Array<string> }> = [{ id: "m1" }];
      const fetchModels = async () => {
        fetchCount++;
        return [...models];
      };
      const resolveHelper = async (
        sel: { id: string },
        opts: { listModels?: () => Promise<Array<{ id: string }>> },
      ) => {
        const list = (await opts.listModels?.()) ?? [];
        const match = list.find((m) => m.id === sel.id);
        if (!match) throw new Error(`missing:${sel.id}`);
        return match;
      };

      const PlatformCtor =
        label === "webpack"
          ? (() => {
              const match = patched.match(/class Platform\{[\s\S]*\}\}\};$/);
              assert.isDefined(match);
              return new Function(
                "fetchModels",
                "resolveHelper",
                `${match![0].slice(0, -3)}; return Platform;`,
              )(fetchModels, resolveHelper);
            })()
          : new Function("fetchModels", "resolveM", `${patched}; return Plat;`)(
              fetchModels,
              resolveHelper,
            );

      const plat = new PlatformCtor();
      await plat.resolveLocalModelSelection({ id: "m1" }, "api-key", 1);
      assert.equal(fetchCount, 1);

      // Cached hit: does not refetch
      await plat.resolveLocalModelSelection({ id: "m1" }, "api-key", 1);
      assert.equal(fetchCount, 1);

      // Newly added model after cache warm: invalidates and refetches once
      models.push({ id: "m2" });
      const resolved = await plat.resolveLocalModelSelection({ id: "m2" }, "api-key", 1);
      assert.deepStrictEqual(resolved, { id: "m2" });
      assert.equal(fetchCount, 2);

      // Unknown model on stale cache -> refetches once, still missing -> throws without looping
      let failed = false;
      try {
        await plat.resolveLocalModelSelection({ id: "m-unknown" }, "api-key", 1);
      } catch (err) {
        failed = err instanceof Error && err.message === "missing:m-unknown";
      }
      assert.isTrue(failed);
      assert.equal(fetchCount, 3);
    }
  });

  it("patches agent.d.ts and rejects duplicate resume declaration", () => {
    const sf = parseSource(MINIMAL_AGENT_DTS, "agent.d.ts", ts.ScriptKind.TS);
    const edits = collectAgentDtsResumeEdits(sf);
    assert.equal(edits.length, 1);
    const patched = applyTextEdits(MINIMAL_AGENT_DTS, edits);
    assertValidSyntax(patched, "agent.d.ts", ts.ScriptKind.TS);
    assert.include(patched, "resume?(options?: SendOptions): Promise<Run>;");

    const patchedSf = parseSource(patched, "agent.d.ts", ts.ScriptKind.TS);
    assert.throws(() => collectAgentDtsResumeEdits(patchedSf), /already declares resume/);
  });

  it("fails loudly on overlapping edits, syntax errors, and non-unique ResumeAction anchors", () => {
    assert.throws(
      () =>
        applyTextEdits("abcdef", [
          { start: 1, end: 4, replacement: "x", label: "a" },
          { start: 3, end: 5, replacement: "y", label: "b" },
        ]),
      /overlapping edits/,
    );
    assert.throws(() => assertValidSyntax("function broken( {", "bad.js"), /syntax error/);

    const duplicateResume = parseSource(
      `class A{static $(){return["ResumeAction"]}} class B{static $(){return["ResumeAction"]}} class C{static $(){return["SummarizeAction"]}}`,
      "dup.js",
    );
    assert.throws(
      () => findResumeActionClassInBundle(duplicateResume),
      /expected exactly 1 match, found 2/,
    );
  });
});

it.layer(ScriptTestLayer)("patch-cursor-sdk package orchestration & CLI", (it) => {
  const writeSyntheticPackage = Effect.fn("writeSyntheticPackage")(function* (rootDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files: ReadonlyArray<readonly [string, string]> = [
      ["package.json", JSON.stringify({ name: "@cursor/sdk", version: "9.9.9" })],
      ["dist/esm/agent.d.ts", MINIMAL_AGENT_DTS],
      ["dist/cjs/agent.d.ts", MINIMAL_AGENT_DTS],
      ["dist/esm/index.js", makeWebpackIndexFixture()],
      ["dist/cjs/index.js", makeWebpackIndexFixture()],
      ["dist/esm/4242.js", makeWebpackChunkFixture()],
      ["dist/cjs/8888.js", makeWebpackChunkFixture()],
      ["dist/bundled/index.js", makeBundledFixture()],
    ];
    for (const [rel, content] of files) {
      const full = path.join(rootDir, rel);
      yield* fs.makeDirectory(path.dirname(full), { recursive: true });
      yield* fs.writeFileString(full, content);
    }
  });

  it.effect(
    "discovers dynamic chunk filenames, generates a valid git patch, and honors --check",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "patch-cursor-sdk-test-" });
        const pkgDir = path.join(tmp, "pkg");
        const outPatch = path.join(tmp, "out.patch");
        yield* writeSyntheticPackage(pkgDir);

        // Dry-run --check verifies without writing
        yield* runCli(["--check", "--dir", pkgDir, "--out", outPatch]);
        assert.isFalse(yield* fs.exists(outPatch));

        // Direct package patch + unified diff
        const result = yield* patchCursorSdkPackage(pkgDir);
        assert.equal(result.version, "9.9.9");
        assert.deepStrictEqual(
          result.files.map((f) => f.relativePath),
          [
            "dist/bundled/index.js",
            "dist/cjs/8888.js",
            "dist/cjs/agent.d.ts",
            "dist/cjs/index.js",
            "dist/esm/4242.js",
            "dist/esm/agent.d.ts",
            "dist/esm/index.js",
          ],
        );

        const diffText = yield* generateUnifiedPatch(result.files);
        assert.include(diffText, "diff --git a/dist/esm/4242.js b/dist/esm/4242.js");
        assert.include(diffText, "diff --git a/dist/cjs/8888.js b/dist/cjs/8888.js");
        assert.include(diffText, "diff --git a/dist/bundled/index.js b/dist/bundled/index.js");

        // Full CLI write mode
        yield* runCli(["--dir", pkgDir, "--out", outPatch]);
        assert.isTrue(yield* fs.exists(outPatch));
        assert.equal(yield* fs.readFileString(outPatch), diffText);
      }),
  );

  it.effect("fails loudly when a required chunk anchor is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "patch-cursor-sdk-missing-" });
      const pkgDir = path.join(tmp, "pkg");
      yield* writeSyntheticPackage(pkgDir);
      // Drop the ESM chunk so all chunk anchors have 0 matches
      yield* fs.remove(path.join(pkgDir, "dist/esm/4242.js"));

      const exit = yield* Effect.exit(patchCursorSdkPackage(pkgDir));
      if (!Exit.isFailure(exit)) {
        assert.fail("expected patchCursorSdkPackage to fail when chunk is missing");
      }
      const failure = exit.cause.reasons.find((r) => r._tag === "Fail");
      assert.isDefined(failure);
      assert.isTrue(isCursorSdkPatchError(failure.error));
      assert.include(failure.error.message, "expected exactly 1 match across chunks, found 0");
    }),
  );
});
