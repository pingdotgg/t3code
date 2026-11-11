#!/usr/bin/env node
// An eval script, not server code: it shells out to git and reads files directly.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { proxyConfig } from "../shared/proxy.ts";
import { cases, type Case } from "./cases.ts";
import { grade, testRange, type Comment } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", multiple: true },
    prompt: { type: "string" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "2" },
    concurrency: { type: "string", default: "6" },
    reasoning: { type: "string", default: "low" },
  },
});
if (!values.out) throw new Error("Use --out <directory> [--model <id>] [--prompt <file>].");
const outDirectory = values.out;
const models = values.model ?? ["gpt-6.1-terra", "gpt-6-luna"];
const repo = NodePath.resolve(import.meta.dirname, "../..");
const checkFile =
  values.prompt ?? NodePath.join(repo, ".macroscope/check-run-agents/test-signal.md");
// Macroscope gives the model the body; the front matter only configures the run.
const instructions = NodeFS.readFileSync(checkFile, "utf8")
  .replace(/^---\n[\s\S]*?\n---\n/, "")
  .trim();
const words = instructions.split(/\s+/).length;
const promptHash = NodeCrypto.createHash("sha256").update(instructions).digest("hex").slice(0, 12);
const selected = values.case ? cases.filter((entry) => values.case!.includes(entry.id)) : cases;
const proxy = proxyConfig();

const git = (args: ReadonlyArray<string>) => {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  return result.status === 0 ? result.stdout : undefined;
};

/** The case's PR head as files the model can read, plus the diff it reviews. */
const world = (entry: Case) => {
  const files = new Map<string, string>();
  if (entry.type === "real") {
    const diff = git(["diff", `${entry.rev}~1`, entry.rev, "--", ...entry.paths]);
    // An empty diff would grade a guard case as a clean pass.
    if (!diff) throw new Error(`${entry.id}: no diff at ${entry.rev}.`);
    return { diff, files };
  }
  const before = git(["show", `${entry.rev}:${entry.path}`]);
  if (!before?.includes(entry.after)) throw new Error(`${entry.id}: anchor not found.`);
  const after = before.replace(entry.after, entry.after + entry.insert);
  files.set(entry.path, after);
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-test-signal-"));
  NodeFS.writeFileSync(NodePath.join(directory, "before"), before);
  NodeFS.writeFileSync(NodePath.join(directory, "after"), after);
  const raw = NodeChildProcess.spawnSync("git", ["diff", "--no-index", "before", "after"], {
    cwd: directory,
    encoding: "utf8",
  }).stdout;
  NodeFS.rmSync(directory, { recursive: true });
  const diff = raw
    .replace("diff --git a/before b/after", `diff --git a/${entry.path} b/${entry.path}`)
    .replace("--- a/before", `--- a/${entry.path}`)
    .replace("+++ b/after", `+++ b/${entry.path}`);
  return { diff, files };
};

// The check reads the rules at the PR head, where they always exist. Old case commits predate
// them, so serve the rules from this checkout.
const ruleFiles = new Set(["docs/internals/testing.md", "AGENTS.md"]);
const readAt = (entry: Case, files: Map<string, string>, path: string) =>
  ruleFiles.has(path)
    ? NodeFS.readFileSync(NodePath.join(repo, path), "utf8")
    : (files.get(path) ?? git(["show", `${entry.rev}:${path}`]));

/** `git grep` at `rev`, with overlay and rule files searched in their served form instead. */
const grepAt = (entry: Case, files: Map<string, string>, pattern: string, scope: string) => {
  // Status 2 is a bad pattern. Show grep's message, as a real tool would, so the model can fix it.
  const check = NodeChildProcess.spawnSync("grep", ["-E", "--", pattern], {
    input: "",
    encoding: "utf8",
  });
  if (check.status !== 0 && check.status !== 1) return check.stderr.trim() || "grep failed.";
  const served = new Map(files);
  for (const path of ruleFiles) served.set(path, readAt(entry, files, path) ?? "");
  // Served files also exist in this checkout, so git applies its own pathspec rules to the scope.
  const matched = new Set((git(["ls-files", "--", scope || "."]) ?? "").split("\n"));
  const inScope = (path: string) => matched.has(path);
  const fromRev = (git(["grep", "-n", "-E", "-e", pattern, entry.rev, "--", scope || "."]) ?? "")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.replace(`${entry.rev}:`, ""))
    .filter((line) => !served.has(line.slice(0, line.indexOf(":"))));
  const fromServed = [...served]
    .filter(([path]) => inScope(path))
    .flatMap(([path, text]) =>
      NodeChildProcess.spawnSync("grep", ["-n", "-E", "--", pattern], {
        input: text,
        encoding: "utf8",
      })
        .stdout.split("\n")
        .filter((line) => line !== "")
        .map((line) => `${path}:${line}`),
    );
  return [...fromServed, ...fromRev].slice(0, 80).join("\n") || "No matches.";
};

const tools = [
  {
    type: "function",
    name: "read_file",
    description: "Read a file at the pull request head, with line numbers.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        start_line: { type: "integer" },
        end_line: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    type: "function",
    name: "grep",
    description:
      "Search the repository at the pull request head with an extended regular expression.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"],
    },
  },
  {
    type: "function",
    name: "post_comment",
    description: "Post an inline review comment on a line of the pull request head.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, line: { type: "integer" }, body: { type: "string" } },
      required: ["path", "line", "body"],
    },
  },
];

const system = (body: string) =>
  [
    "You are a Macroscope Check Run Agent reviewing a GitHub pull request.",
    "Follow the check instructions below. Read the repository at the pull request head with read_file and grep.",
    "Leave inline review comments with post_comment. Then give your final response.",
    "",
    "<check_instructions>",
    body,
    "</check_instructions>",
  ].join("\n");

const decodeResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      output: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
      usage: Schema.optional(Schema.Struct({ total_tokens: Schema.optional(Schema.Number) })),
    }),
  ),
);
const decodeArguments = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeRow = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const post = Effect.fn("evaluateTestSignal.post")(function* (body: unknown) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      schedule: Schedule.exponential("2 seconds"),
      times: 4,
    }),
  );
  const response = yield* HttpClientRequest.post(`${proxy.url}/responses`).pipe(
    HttpClientRequest.setHeaders(proxy.headers),
    HttpClientRequest.bodyJson(body),
    Effect.flatMap(client.execute),
  );
  const text = yield* response.text;
  if (response.status !== 200)
    return yield* Effect.die(new Error(`Model API ${response.status}: ${text}`));
  return decodeResponse(text);
});

const runSample = Effect.fn("evaluateTestSignal.sample")(function* (entry: Case, model: string) {
  const { diff, files } = world(entry);
  const comments: Array<Comment> = [];
  const input: Array<unknown> = [
    {
      role: "user",
      content: `Pull request diff for the files this check includes:\n\n\`\`\`diff\n${diff}\`\`\``,
    },
  ];
  let final = "";
  let tokens = 0;
  for (let step = 0; step < 16; step++) {
    const response = yield* post({
      model,
      instructions: system(instructions),
      input,
      tools,
      reasoning: { effort: values.reasoning },
      store: false,
      include: ["reasoning.encrypted_content"],
    });
    tokens += response.usage?.total_tokens ?? 0;
    input.push(...response.output);
    const calls = response.output.filter((item) => item.type === "function_call");
    final = response.output
      .filter((item) => item.type === "message")
      .flatMap((item) => (item.content as Array<{ text?: string }>).map((part) => part.text ?? ""))
      .join("");
    if (calls.length === 0) break;
    for (const call of calls) {
      const args = decodeArguments(String(call.arguments));
      let output: string;
      if (call.name === "post_comment") {
        comments.push({
          path: String(args.path),
          line: Number(args.line),
          body: String(args.body),
        });
        output = "Posted.";
      } else if (call.name === "read_file") {
        const text = readAt(entry, files, String(args.path));
        const lines = text?.split("\n") ?? [];
        const start = Math.max(1, Number(args.start_line ?? 1));
        const end = Math.min(lines.length, Number(args.end_line ?? start + 399));
        output =
          text === undefined
            ? "File not found."
            : lines
                .slice(start - 1, end)
                .map((line, index) => `${start + index}: ${line}`)
                .join("\n");
      } else {
        output = grepAt(entry, files, String(args.pattern), String(args.path ?? ""));
      }
      input.push({ type: "function_call_output", call_id: call.call_id, output });
    }
  }
  const targets = entry.targets.flatMap((target) => {
    const range = testRange(readAt(entry, files, target.path) ?? "", target.title);
    if (!range) throw new Error(`${entry.id}: target "${target.title}" not found.`);
    return [{ path: target.path, ...range }];
  });
  return { ...grade({ kind: entry.kind, targets, comments, final }), comments, final, tokens };
});

const sampleSafely = (entry: Case, model: string, sample: number) =>
  runSample(entry, model).pipe(
    Effect.map((result) => ({ case: entry.id, kind: entry.kind, model, sample, ...result })),
    Effect.catchCause((cause) =>
      Effect.succeed({ case: entry.id, kind: entry.kind, model, sample, error: String(cause) }),
    ),
  );

type Row = Effect.Success<ReturnType<typeof sampleSafely>>;
const isGraded = (row: Row) => "pass" in row;
const passed = (row: Row) => "pass" in row && row.pass;

const summary = await Effect.runPromise(
  Effect.gen(function* () {
    NodeFS.mkdirSync(outDirectory, { recursive: true });
    const samples = Number(values.samples);
    const pairs = models.flatMap((model) => selected.map((entry) => ({ model, entry })));
    const rows: Array<Row> = (yield* Effect.forEach(
      pairs.flatMap(({ model, entry }) =>
        Array.from({ length: samples }, (_, n) => ({ model, entry, n })),
      ),
      ({ model, entry, n }) => sampleSafely(entry, model, n),
      { concurrency: Number(values.concurrency) },
    )).slice();
    // A third sample settles a split.
    const splits = pairs.filter(({ model, entry }) => {
      const own = rows.filter((row) => row.model === model && row.case === entry.id);
      return own.length === 2 && own.some(passed) && !own.every(passed);
    });
    rows.push(
      ...(yield* Effect.forEach(splits, ({ model, entry }) => sampleSafely(entry, model, samples), {
        concurrency: Number(values.concurrency),
      })),
    );
    NodeFS.writeFileSync(
      NodePath.join(outDirectory, "results.ndjson"),
      rows.map((row) => encodeRow(row)).join("\n") + "\n",
    );

    const lines = [`prompt ${promptHash}, ${words} words, ${checkFile}`, ""];
    lines.push("| model | bad caught | guards clean | errors | tokens |", "|---|---|---|---|---|");
    for (const model of models) {
      const verdicts = selected.map((entry) => {
        const own = rows.filter((row) => row.model === model && row.case === entry.id);
        // A run error counts as a failed sample, so one pass and one error is not a majority.
        const graded = own.filter(isGraded);
        const passes = own.filter(passed).length;
        return {
          entry,
          pass: passes > own.length / 2,
          errors: own.length - graded.length,
        };
      });
      const count = (kind: Case["kind"]) => {
        const own = verdicts.filter((verdict) => verdict.entry.kind === kind);
        return `${own.filter((verdict) => verdict.pass).length}/${own.length}`;
      };
      const tokens = rows
        .filter((row) => row.model === model && "tokens" in row)
        .reduce((sum, row) => sum + ("tokens" in row ? row.tokens : 0), 0);
      const errors = verdicts.reduce((sum, verdict) => sum + verdict.errors, 0);
      lines.push(`| ${model} | ${count("bad")} | ${count("guard")} | ${errors} | ${tokens} |`);
      const failed = verdicts.filter((verdict) => !verdict.pass).map((verdict) => verdict.entry.id);
      if (failed.length > 0) lines.push(`|  failed: ${failed.join(", ")} | | | | |`);
    }
    const report = lines.join("\n") + "\n";
    NodeFS.writeFileSync(NodePath.join(outDirectory, "summary.md"), report);
    return report;
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
process.stdout.write(summary);
