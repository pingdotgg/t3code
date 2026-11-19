// Text generation differential check: the T3 server's own text generator code and this
// server's run the same cases against one loopback model API stub, and the answers and the
// requests must agree.
//
//   node crates/conn-server/tools/textgen-diff.mjs <examples/text_generation binary>
//
// - Requests: `TextGenerators.listModels` and a thread title through `TextGenerators.runner`
//   and `fromRunner(...).generateThreadTitle` (apps/server/src/textGeneration,
//   packages/provider-core) with the real fetch client, against `crates/conn-server/examples/
//   text_generation.rs`. Each request's method, path with query, body bytes and headers must be
//   equal, the headers Node's fetch adds included; only `host` and `content-length` are
//   left out (`TRANSPORT`, listed once). Some answers come gzip or deflate encoded. The answer
//   or the error text must be equal.
// - Functions: `buildThreadTitlePrompt`, `formatThreadTitleContext`, `sanitizeThreadTitle`
//   and `localeCompare` on model ids, on generated cases.
// No outside call: the only server is the stub on 127.0.0.1. No model is called.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeZlib from "node:zlib";

import { importSource, packageImporter } from "../../../tools/monorepo.mjs";
import { sealedEnvTemp } from "../../../tools/sealed-env.mjs";

const load = packageImporter("apps/server");
const Effect = await load("effect/Effect");
const Exit = await load("effect/Exit");
const Layer = await load("effect/Layer");
const { FetchHttpClient } = await load("effect/http");
// The workspace packages export their sources for `import` only; the same files, by path.
const SecretResolver = await importSource("packages/secret-provider-core/src/server/SecretResolver.ts");
const core = (name) => importSource(`packages/provider-core/src/server/${name}.ts`);
const Operations = await core("textGenerationOperations");
const Prompts = await core("textGenerationPrompts");
const Context = await core("threadTitleContext");
const Utils = await core("textGenerationUtils");
const { isAttachmentOnlyBootstrapPrompt } = await importSource(
  "packages/shared/src/composerContextReferences.ts",
);
const ServerSettings = await importSource("apps/server/src/serverSettings.ts");
const TextGenerators = await importSource("apps/server/src/textGeneration/TextGenerators.ts");

const [binary] = process.argv.slice(2);
if (!binary) throw new Error("usage: textgen-diff.mjs <examples/text_generation binary>");

/** Headers whose value is the connection's own (the port, the body length); reported, not
 * compared. Every other header, the ones Node's fetch adds included, must be equal. */
const TRANSPORT = new Set(["host", "content-length"]);

// ---- The stub ----------------------------------------------------------------------------

let script = () => ({ status: 500, body: "{}" });
let recorded = [];
const stub = NodeHttp.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const entry = {
      method: request.method,
      path: request.url,
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
      ),
      body: Buffer.concat(chunks).toString("utf8"),
    };
    recorded.push(entry);
    const { status, body, encoding } = script(entry);
    const text = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    // An endpoint may compress its answer, as fetch asked; both sides must decode it.
    const encoded =
      encoding === "gzip" ? NodeZlib.gzipSync(text)
      : encoding === "deflate" ? NodeZlib.deflateSync(text)
      : encoding === "deflate-raw" ? NodeZlib.deflateRawSync(text)
      : text;
    const headers = { "content-type": "application/json" };
    if (encoding !== undefined) headers["content-encoding"] = encoding === "deflate-raw" ? "deflate" : encoding;
    response.writeHead(status, headers);
    response.end(encoded);
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${stub.address().port}`;

// ---- The Rust side -----------------------------------------------------------------------

const probe = NodeChildProcess.spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"], env: sealedEnvTemp() });
let pending = "";
const waiting = [];
probe.stdout.on("data", (data) => {
  pending += data;
  let newline;
  while ((newline = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    waiting.shift()?.(JSON.parse(line));
  }
});
const rust = (testCase) =>
  new Promise((resolve) => {
    waiting.push(resolve);
    probe.stdin.write(`${JSON.stringify(testCase)}\n`);
  });

// ---- The T3 side -------------------------------------------------------------------------

const layer = (settings) =>
  Layer.effect(TextGenerators.TextGenerators, TextGenerators.make).pipe(
    Layer.provideMerge(ServerSettings.layerTest(settings)),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
  );

async function t3(testCase) {
  const program = Effect.gen(function* () {
    const generators = yield* TextGenerators.TextGenerators;
    if (testCase.op === "listModels") return yield* generators.listModels(testCase.input);
    const selection = testCase.settings.textGenerationModelSelection;
    const runner = yield* generators.runner(selection.instanceId);
    const service = Operations.fromRunner("TextGenerator", runner);
    const request = testCase.request;
    const regenerate = request.previousTitle !== undefined;
    const context = regenerate
      ? Context.formatThreadTitleContext(request.messages)
      : {
          message: isAttachmentOnlyBootstrapPrompt(request.message.text) ? "" : request.message.text,
          attachments: request.message.attachments ?? [],
        };
    const result = yield* service.generateThreadTitle({
      cwd: "/unused",
      message: context.message,
      projectTitle: request.projectTitle,
      attachments: context.attachments,
      ...(regenerate ? { previousTitle: request.previousTitle } : {}),
      instructions: testCase.settings.threadTitleInstructions ?? "",
      modelSelection: selection,
    });
    return result.title;
  });
  const exit = await Effect.runPromise(Effect.exit(program.pipe(Effect.provide(layer(testCase.settings)))));
  if (Exit.isSuccess(exit)) return { ok: exit.value };
  const fail = exit.cause.reasons.find((r) => r._tag === "Fail");
  return { err: fail?.error?.detail ?? String(exit.cause) };
}

// ---- Cases -------------------------------------------------------------------------------

for (const includeBranch of [false, true]) {
  for (const policy of ["", "Use direct words.", "A".repeat(21000)]) {
    const input = {branch: "feature/fix", stagedSummary: "M\tfile", stagedPatch: "@@POLICY@@ @@PATCH@@ @@SUMMARY@@\nAdditional instructions:\n\n" + "diff\n".repeat(9000), policy, includeBranch};
    const actual = await rust({op: "commitPrompt", input});
    const expected = Prompts.buildCommitMessagePrompt({...input, policy: {commitInstructions: policy}}).prompt;
    if (actual.ok !== expected) throw new Error("commit prompt differs from T3");
  }
}


const failures = [];
const transportSeen = { t3: new Set(), rust: new Set() };
// Key order does not count (serde_json writes keys sorted); strings are compared whole.
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]))
      : value;
const same = (label, ours, theirs) => {
  const a = JSON.stringify(canonical(ours));
  const b = JSON.stringify(canonical(theirs));
  if (a === b) console.log(`ok   ${label}`);
  else failures.push(`${label}\n  ours:     ${a.slice(0, 600)}\n  upstream: ${b.slice(0, 600)}`);
};
const compared = (requests, side) =>
  requests.map((r) => {
    const headers = {};
    for (const [k, v] of Object.entries(r.headers)) {
      if (TRANSPORT.has(k)) transportSeen[side].add(k === "host" || k === "content-length" ? k : `${k}: ${v}`);
      else headers[k] = v;
    }
    return { method: r.method, path: r.path, headers: Object.fromEntries(Object.entries(headers).sort()), body: r.body };
  });

const generator = (extra) => ({
  textGenerators: { tg: { kind: "openaiCompatible", baseUrl: `${base}/v1`, enabled: true, ...extra } },
});
const chat = (content, finish = "stop") => ({ status: 200, body: { choices: [{ finish_reason: finish, message: { content } }] } });
const message = (text, attachments = []) => ({ role: "user", text, attachments });
const png = (id, name) => ({ type: "image", id, name, mimeType: "image/png", sizeBytes: 1234 });

const requestCases = [
  { name: "openai list", settings: generator({ apiKey: "k1" }), input: { id: "tg" },
    reply: () => ({ status: 200, body: { data: [{ id: " b " }, { id: "A", name: "Model A" }, { id: "" }, { id: "a-1" }] } }) },
  { name: "gzip answer", settings: generator({ apiKey: "k1" }), input: { id: "tg" },
    reply: () => ({ status: 200, encoding: "gzip", body: { data: [{ id: "z" }, { id: "a" }] } }) },
  { name: "deflate answer", settings: generator({ apiKey: "k1" }), input: { id: "tg" },
    reply: () => ({ status: 200, encoding: "deflate", body: { data: [{ id: "d" }] } }) },
  { name: "raw deflate answer", settings: generator({ apiKey: "k1" }), input: { id: "tg" },
    reply: () => ({ status: 200, encoding: "deflate-raw", body: { data: [{ id: "r" }] } }) },
  { name: "gzip error answer", settings: generator({ apiKey: "k1" }), input: { id: "tg" },
    reply: () => ({ status: 401, encoding: "gzip", body: { error: { message: "zipped no" } } }) },
  { name: "openai list without key", settings: generator({}), input: { id: "tg" },
    reply: () => ({ status: 200, body: { data: [] } }) },
  { name: "anthropic list with pages", settings: generator({ kind: "anthropic", apiKey: "k2", baseUrl: `${base}/v1/` }), input: { id: "tg" },
    reply: (r) => r.path.includes("after_id")
      ? { status: 200, body: { data: [{ id: "claude-a" }], has_more: false } }
      : { status: 200, body: { data: [{ id: "claude-b", display_name: "Claude B" }], has_more: true, last_id: "claude-b" } } },
  { name: "unsaved config with a test", settings: generator({ apiKey: "saved" }),
    input: { id: "draft", config: { kind: "openaiCompatible", baseUrl: `${base}/x`, apiKey: "typed", enabled: true }, test: true },
    reply: (r) => r.path.endsWith("/models") ? { status: 200, body: { data: [{ id: "big" }, { id: "gpt-mini" }] } } : chat("OK") },
  { name: "anthropic test", settings: generator({ kind: "anthropic", apiKey: "k3" }), input: { id: "tg", test: true, model: "claude-x" },
    reply: (r) => r.path.includes("/models") ? { status: 200, body: { data: [{ id: "claude-x" }] } }
      : { status: 200, body: { stop_reason: "end_turn", content: [{ type: "text", text: "OK" }] } } },
  { name: "401 with a message", settings: generator({ apiKey: "bad", label: "Router" }), input: { id: "tg" },
    reply: () => ({ status: 401, body: { error: { message: "  Incorrect API key provided  " } } }) },
  { name: "404 without a body", settings: generator({}), input: { id: "tg" }, reply: () => ({ status: 404, body: "" }) },
  { name: "429", settings: generator({}), input: { id: "tg" }, reply: () => ({ status: 429, body: { error: { message: "slow down" } } }) },
  { name: "500", settings: generator({}), input: { id: "tg" }, reply: () => ({ status: 500, body: "oops" }) },
  { name: "unreadable list", settings: generator({}), input: { id: "tg" }, reply: () => ({ status: 200, body: { models: [] } }) },
  { name: "missing generator", settings: generator({}), input: { id: "nope" }, reply: () => ({ status: 200, body: {} }) },
  { name: "test with no models", settings: generator({}), input: { id: "tg", test: true }, reply: () => ({ status: 200, body: { data: [] } }) },
  { name: "test hits the output limit", settings: generator({}), input: { id: "tg", test: true, model: "m" },
    reply: (r) => r.path.endsWith("/models") ? { status: 200, body: { data: [{ id: "m" }] } } : chat("x", "length") },
].map((c) => ({ ...c, op: "listModels" }));

const titleSettings = (extra = {}) => ({
  ...generator({ apiKey: "tk" }),
  textGenerationModelSelection: { instanceId: "tg", model: "small/model" },
  ...extra,
});
const titleCases = [
  { name: "first title", settings: titleSettings(), request: { projectTitle: "Conn", message: message("Fix the login button on mobile") },
    reply: () => chat('{"title":"Fix Mobile Login Button","needsRefinement":false}') },
  { name: "first title, no project, attachments and instructions",
    settings: titleSettings({ threadTitleInstructions: "  Use Title Case.  " }),
    request: { message: message("what is this?", [png("a1", "screen.png")]) },
    reply: () => chat('```json\n{"title": "  \\"Login   Screen Bug\\"  "}\n```') },
  { name: "first title from files only", settings: titleSettings(),
    request: { projectTitle: "  ", message: message("[User attached one or more files without additional text. Respond using the conversation context and the attached files.]", [png("a2", "a.png")]) },
    reply: () => chat('{"title":"Screenshot Review"}') },
  { name: "regenerate", settings: titleSettings(),
    request: { projectTitle: "Conn", previousTitle: "Fix login", messages: [
      message("Fix login"), { role: "assistant", text: "Done: the token now refreshes.", attachments: [] },
      message("Also make it remember the user", [png("a3", "b.png")]), { role: "assistant", text: "  ", attachments: [] } ] },
    reply: () => chat('{"title":"Remembered Login Sessions"}') },
  { name: "regenerate, long thread", settings: titleSettings(),
    request: { previousTitle: "Old", messages: Array.from({ length: 30 }, (_, i) =>
      i % 2 ? { role: "assistant", text: `answer ${i} ${"z".repeat(900)}`, attachments: [] } : message(`question ${i} ${"q😀".repeat(700)}`)) },
    reply: () => chat('{"title":"title"}') },
  { name: "regenerate, model fails", settings: titleSettings(),
    request: { previousTitle: "Old", messages: [message("hello")] },
    reply: () => ({ status: 401, body: { error: { message: "nope" } } }) },
  { name: "regenerate, invalid output", settings: titleSettings(),
    request: { previousTitle: "Old", messages: [message("hello")] }, reply: () => chat("no json here") },
  { name: "regenerate, generator off", settings: { ...titleSettings(), textGenerators: { tg: { kind: "openaiCompatible", baseUrl: `${base}/v1`, enabled: false } } },
    request: { previousTitle: "Old", messages: [message("hello")] }, reply: () => chat("{}") },
].map((c) => ({ ...c, op: "title" }));

for (const testCase of [...requestCases, ...titleCases]) {
  const { reply, ...wire } = testCase;
  script = reply;
  recorded = [];
  const theirs = await t3(wire);
  const theirRequests = compared(recorded, "t3");
  recorded = [];
  const ours = await rust(wire);
  const ourRequests = compared(recorded, "rust");
  same(`${testCase.op} ${testCase.name}: answer`, ours, theirs);
  same(`${testCase.op} ${testCase.name}: requests`, ourRequests, theirRequests);
}

// ---- Functions ---------------------------------------------------------------------------

const long = "word ".repeat(3000);
const emoji = "😀".repeat(5000);
const promptInputs = [];
for (const projectTitle of [undefined, "Conn", '  T3 "Code"  ', ""]) {
  for (const previousTitle of [undefined, "Old \"title\""]) {
    for (const text of ["Fix it", long, emoji, `[Earlier content truncated]\n\n${long}`, `a${emoji}`]) {
      promptInputs.push({ message: text, projectTitle, previousTitle });
    }
  }
}
promptInputs.push({ message: "m", instructions: "  Be brief.  ", attachments: [png("x", "x.png"), { ...png("y", "y.pdf"), mimeType: "application/pdf", sizeBytes: 9 }] });
promptInputs.push({ message: "m", instructions: "i".repeat(25_000) });
promptInputs.push({ message: "m", attachments: Array.from({ length: 200 }, (_, i) => png(`p${i}`, `file-${i}-${"n".repeat(30)}.png`)) });
for (const input of promptInputs) {
  const theirs = Prompts.buildThreadTitlePrompt(input).prompt;
  const ours = await rust({ op: "prompt", input });
  same(`prompt ${JSON.stringify(input).slice(0, 60)}`, ours, { ok: theirs });
}

const contexts = [
  [message("one")],
  [message("first", [png("f", "f.png")]), { role: "assistant", text: "reply" }, message("second", [png("s", "s.png")])],
  [{ role: "system", text: "sys" }, { role: "reasoning", text: "think" }, message("  "), message("real")],
  Array.from({ length: 40 }, (_, i) => (i % 3 === 2 ? { role: "assistant", text: `a${i} ${"x".repeat(3000)}` } : message(`u${i} ${"😀y".repeat(1500)}`, i % 5 ? [] : [png(`i${i}`, `i${i}.png`)]))),
  [message("u".repeat(10_000)), { role: "assistant", text: "a".repeat(10_000) }],
  [message("[User attached one or more files without additional text. Respond using the conversation context and the attached files.]", [png("only", "only.png")])],
  // Assistant quotes become their text (assistantCitationsToPlainText); broken ones stay.
  [
    message(`About [Assistant quote](t3-citation://v1/env/thread-1/msg%201?text=Use+the+cache&start=3&end=17&prefix=a&suffix=b) please`),
    { role: "assistant", text: "[Assistant quote](t3-citation://v1/e/t/m?text=x&start=1&end=2&prefix=&suffix=&comment=Why%3F%20%E2%82%AC) and [Assistant quote](t3-citation://v1/e/t/m?text=x&start=2&end=1&prefix=&suffix=)" },
    message("[Assistant quote](t3-citation://v1/e/t?text=x&start=1&end=2&prefix=&suffix=) [Assistant quote](t3-citation://v1/e/t/%E0?text=x&start=1&end=2&prefix=&suffix=) [Assistant quote](t3-citation://v1/e/t/m?text=x&start=1&end=2&prefix=&suffix=&extra=1) [Assistant quote](t3-citation://v1/e/t/m?text=%20&start=1&end=2&prefix=&suffix=)"),
    message("[Assistant quote](t3-citation://v1/e/t/m?text=x&start=1&end=2&prefix=&suffix=#frag) [Assistant quote](t3-citation://v1/e/t/m?text=x&start=1&end=99999999999999999&prefix=&suffix=) [Assistant quote](t3-citation://v1/e/t/m?text=x&text=y&start=1&end=2&prefix=&suffix=)"),
  ],
].map((list) => list.map((m) => ({ attachments: [], ...m })));
for (const messages of contexts) {
  const theirs = Context.formatThreadTitleContext(messages);
  const ours = await rust({ op: "context", messages });
  same(`context of ${messages.length} messages`, ours, {
    ok: { message: theirs.message, attachments: theirs.attachments.map(({ id, name, mimeType, sizeBytes }) => ({ id, name, mimeType, sizeBytes })) },
  });
}

for (const raw of ["Fix login", '  "Fix   login"\r\nmore', '{"title":"`Hello`"}', "   ", "''", "t".repeat(200), `${"a".repeat(116)}😀tail`, "Line with spaces", '{"title": 5}', "﻿Title﻿"]) {
  same(`sanitize ${JSON.stringify(raw).slice(0, 40)}`, await rust({ op: "sanitize", raw }), { ok: Utils.sanitizeThreadTitle(raw) });
}

const ids = ["gpt-4o", "gpt-4o-mini", "GPT-4", "gpt-4.1", "gpt_4", "o1", "o3-mini", "claude-3-5-haiku-20241022", "claude-sonnet-4-5", "Claude-Opus", "openai/gpt-4o", "anthropic/claude-3.5-sonnet", "meta-llama/llama-3.1-70b-instruct", "mistralai/mixtral-8x7b", "google/gemini-2.0-flash-001", "deepseek/deepseek-r1:free", "qwen/qwen-2.5-72b-instruct", "x-ai/grok-2", "a.b", "a-b", "a_b", "a b", "a1", "ab", "AB", "aB", "Ab", "model~1", "model$2", "model+3", "model@4", "model#5", "model(6)", "[7]", "{8}", "9", "10", "z", "Z"];
same("model id order", await rust({ op: "sort", ids }), { ok: [...ids].sort((a, b) => a.localeCompare(b)) });

// ---- Review guides -----------------------------------------------------------------------
// `buildReviewGuidePrompt`, `parseReviewGuideChange` + `normalizeReviewGuide` (after the
// output schema's decode), and `reviewGuideInputFromPullRequest`'s settled review.

const GuideNormalize = await importSource("apps/server/src/pullRequest/pullRequestReviewGuideNormalize.ts");
const GuideInput = await importSource("apps/server/src/pullRequest/pullRequestReviewGuideInput.ts");
const Schema = await load("effect/Schema");
const guidePrompt = (input) => Prompts.buildReviewGuidePrompt(input).prompt;
const guideBase = { number: 42, title: "Add \"guides\" <b>", description: "Body", baseBranch: "main", baseCommit: "abc1234", settledReview: "" };
const guideInputs = [
  guideBase,
  { ...guideBase, description: "  ", settledReview: "- a.rs (resolved, ann): x" },
  { ...guideBase, description: "d".repeat(9000), settledReview: "s".repeat(9000) },
  { ...guideBase, description: `${"😀".repeat(3999)}x😀` },
  { ...guideBase, instructions: "  Be brief.  " },
  { ...guideBase, instructions: "   " },
  { ...guideBase, instructions: "i".repeat(5000) },
  { ...guideBase, stack: [{ number: 42, title: "This", headSha: "h", state: "open" }] },
  { ...guideBase, stack: [{ number: 41, title: "  Base  ", headSha: "aaa", state: "merged" }, { number: 42, title: null, headSha: null, state: "open" }, { number: 43, title: "", headSha: null, state: "closed" }, { number: 44, title: " ", headSha: "ccc", state: "open" }], instructions: "Pref" },
];
for (const input of guideInputs) {
  const ours = await rust({ op: "reviewGuidePrompt", input });
  same(`review guide prompt ${JSON.stringify(input).slice(0, 60)}`, ours, { ok: guidePrompt(input) });
}

const guideSchema = Prompts.buildReviewGuidePrompt(guideBase).outputSchema;
function t3Normalize(nameOnly, patch, guide) {
  let decoded;
  try {
    decoded = Schema.decodeUnknownSync(guideSchema)(guide);
  } catch {
    return { err: "invalid structured output" };
  }
  return { ok: GuideNormalize.normalizeReviewGuide(decoded, GuideNormalize.parseReviewGuideChange(nameOnly, patch)) };
}
const stop = (extra) => ({ title: "Stop", summary: "s", attention: null, excerpts: [], files: [], notes: [], questions: [], ...extra });
const ex = (path, start, end, extra) => ({ path, side: "new", start, end, caption: "", ...extra });
const patchA = [
  "diff --git a/a.rs b/a.rs", "--- a/a.rs", "+++ b/a.rs", "@@ -1,2 +1,3 @@ fn", "--- a/fake", "+++ b/fake", "@@ -10 +11,0 @@", "@@ -20,0 +20,40 @@",
  "diff --git a/gone.rs b/gone.rs", "--- a/gone.rs", "+++ /dev/null", "@@ -1,5 +0,0 @@",
  'diff --git "a/sp ace\\t.rs" "b/sp ace\\t.rs"', '--- "a/sp ace\\t.rs"', '+++ "b/sp ace\\t.rs"', "@@ -0,0 +1,3 @@",
  "diff --git a/name with space.rs b/name with space.rs", "--- a/name with space.rs\t", "+++ b/name with space.rs\t", "@@ -3 +3 @@",
  'diff --git "a/\\303\\251t\\351.rs" "b/\\303\\251t\\351.rs"', '--- "a/\\303\\251t\\351.rs"', '+++ "b/\\303\\251t\\351.rs"', "@@ -1 +1 @@",
  "diff --git a/bin.png b/bin.png", "Binary files a/bin.png and b/bin.png differ",
].join("\n");
const namesA = ["a.rs", "gone.rs", "sp ace\t.rs", "name with space.rs", "ét\uFFFD.rs", "bin.png", "untouched.rs"].join("\0") + "\0";
const guideCases = [
  { stops: [stop({ excerpts: [ex("a.rs", 1, 2), ex("a.rs", 3, 3, { caption: "c" }), ex("a.rs", 2, 1)] })] },
  { stops: [stop({ excerpts: [ex("a.rs", 25, 70), ex("a.rs", 11, 11), ex("gone.rs", 1, 5, { side: "old" }), ex("gone.rs", 1, 5)] })] },
  { stops: [stop({ excerpts: [ex("a.rs", 1, 1), ex("a.rs", 3, 3), ex("a.rs", 2, 2, { caption: "bridge" })] })] },
  { stops: [stop({ title: "  ", files: [{ path: "a.rs", note: "x" }] }), stop({ attention: { kind: "risk", note: "  " }, files: [{ path: "a.rs", note: " " }, { path: "a.rs", note: "dup" }, { path: "nope.rs", note: "n" }] })] },
  { stops: [stop({ excerpts: [ex("sp ace\t.rs", 1, 3)], notes: [{ path: "sp ace\t.rs", line: 2, title: "t", body: "" }, { path: "sp ace\t.rs", line: 9, title: "out", body: "" }, { path: "sp ace\t.rs", line: 1, title: " ", body: "" }] })] },
  { stops: [stop({ excerpts: [ex("name with space.rs", 1, 9), ex("ét\uFFFD.rs", 1, 1)], questions: ["", " ", "Why?"] }), stop({ attention: { kind: "contract", note: "Keep" }, files: [{ path: "name with space.rs", note: "late" }, { path: "bin.png", note: "" }] })] },
  { stops: [] },
  { stops: [stop({ excerpts: [ex("a.rs", 3.0, 4)] })] },
  { stops: [stop({ excerpts: [ex("a.rs", 3.5, 4)] })] },
  { stops: [{ title: "x", summary: "", excerpts: [], files: [], notes: [], questions: [] }] },
  { stops: [stop({ files: [{ path: "a.rs" }] })] },
  { stops: [stop({ attention: { kind: "nitpick", note: "n" } })] },
  { stops: [stop({ extra: 1, excerpts: [{ ...ex("a.rs", 1, 2), more: true }] })], more: 2 },
  { stops: [stop({ excerpts: [ex("a.rs", -4, 0), ex("a.rs", 0, 0, { side: "old" })] })] },
];
for (const [index, guide] of guideCases.entries()) {
  same(`review guide normalize ${index}`, await rust({ op: "reviewGuideNormalize", nameOnly: namesA, patch: patchA, guide }), t3Normalize(namesA, patchA, guide));
}

const thread = (path, isResolved, isOutdated, comments) => ({ path, isResolved, isOutdated, comments });
const activities = [
  { reviewThreads: [] },
  { reviewThreads: [
    thread("a.rs", true, false, [{ author: { login: "ann" }, body: "Fix <!-- hidden\n --> this\n\n  now\u00a0please" }]),
    thread("b.rs", false, true, [{ author: null, body: "z".repeat(250) }]),
    thread("c.rs", false, false, [{ author: { login: "c" }, body: "open" }]),
    thread("d.rs", true, true, []),
    thread("e.rs", true, false, [{ author: { login: "e" }, body: `${"😀".repeat(99)}xx😀😀` }]),
    thread("f.rs", true, false, [{ author: { login: "f" }, body: "<!-- open comment" }]),
  ] },
];
for (const activity of activities) {
  const detail = { number: 1, title: "t", body: "", baseBranch: "main" };
  same(`settled review of ${activity.reviewThreads.length} threads`, await rust({ op: "settledReview", activity }), { ok: GuideInput.reviewGuideInputFromPullRequest(detail, activity, "x").settledReview });
}

// ---- Report ------------------------------------------------------------------------------

probe.stdin.end();
stub.close();
console.log(`transport headers, T3 (fetch): ${[...transportSeen.t3].sort().join("; ")}`);
console.log(`transport headers, this server: ${[...transportSeen.rust].sort().join("; ")}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} difference(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("text generation agrees with the T3 server");
