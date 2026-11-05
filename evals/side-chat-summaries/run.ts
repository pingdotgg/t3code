#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off - Eval runner uses Node's file, HTTP and stdout boundaries.
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { buildSideChatTextPrompt } from "@t3tools/provider-core/server/textGenerationPrompts";
import { buildSideChatSummarizerInput } from "../../apps/server/src/orchestration-v2/sideChat/sideChatText.ts";
import { sideChatSummaryCases, type SideChatSummaryCase } from "./cases.ts";

const MODEL = "claude-haiku-4-5";
const MAX_EVAL_CHARS = 1_800;

type WriterResult = { readonly text: string | null };
type Check = { readonly name: string; readonly pass: boolean; readonly detail: string };
type SampleResult = {
  readonly id: string;
  readonly sample: number;
  readonly summary: string;
  readonly checks: ReadonlyArray<Check>;
  readonly pass: boolean;
};

const ending = /[.!?](?:["'”’)]*)$/;

export const parseYesNo = (text: string): boolean | null => {
  const answer = text
    .trim()
    .match(/^(?:\*\*)?\s*(YES|NO)\b/i)?.[1]
    ?.toUpperCase();
  return answer === "YES" ? true : answer === "NO" ? false : null;
};

export const gradeSummary = (
  fixture: SideChatSummaryCase,
  summary: string,
  learnerStateJudge: boolean | null,
): ReadonlyArray<Check> => [
  {
    name: "length",
    pass: summary.length <= MAX_EVAL_CHARS,
    detail: `${summary.length}/${MAX_EVAL_CHARS} characters`,
  },
  {
    name: "complete-sentence",
    pass: ending.test(summary.trim()),
    detail: "ends with sentence punctuation",
  },
  {
    name: "learner-first",
    pass: learnerStateJudge === true,
    detail:
      fixture.judgeChars === null
        ? "learner state leads or is absent"
        : `learner confusion is named in the first ${fixture.judgeChars} characters`,
  },
];

const summarizerInput = (fixture: SideChatSummaryCase) =>
  buildSideChatSummarizerInput({
    messages: fixture.messages,
    anchor: { messageId: fixture.messages.at(-1)!.id, start: 0, prefix: "" },
    excerpt: "context management",
    anchorOpeningText: null,
  });

const writerBody = (fixture: SideChatSummaryCase, model: string) => {
  const prompt = buildSideChatTextPrompt({
    kind: "opening_summary",
    prompt: summarizerInput(fixture),
  });
  return {
    model,
    max_tokens: 800,
    system: prompt.prompt,
    messages: [{ role: "user", content: "Return the requested JSON summary." }],
  };
};

const judgeBody = (fixture: SideChatSummaryCase, summary: string, model: string) => ({
  model,
  max_tokens: 20,
  system: "Answer only YES or NO.",
  messages: [
    {
      role: "user",
      content: `Rubric: ${fixture.rubric}\nThe summary is:\n${fixture.judgeChars === null ? summary : summary.slice(0, fixture.judgeChars)}\n\nDoes it pass the rubric? Answer YES or NO.`,
    },
  ],
});

const apiCall = async (body: unknown, apiKey: string): Promise<string> => {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Anthropic API ${response.status}: ${await response.text()}`);
  const json = (await response.json()) as { content?: Array<{ text?: string }> };
  return json.content?.map((part) => part.text ?? "").join("") ?? "";
};

const parseWriter = (text: string): WriterResult => {
  const json = JSON.parse(extractJsonObject(text)) as WriterResult;
  return { text: typeof json.text === "string" ? json.text.trim() : null };
};

const selectedCases = (ids: string[] | undefined): ReadonlyArray<SideChatSummaryCase> => {
  const selected =
    ids === undefined
      ? sideChatSummaryCases
      : sideChatSummaryCases.filter((entry) => ids.includes(entry.id));
  if (selected.length === 0) throw new Error("No case matches --case.");
  return selected;
};

const run = async (
  fixture: SideChatSummaryCase,
  sample: number,
  model: string,
  apiKey: string,
): Promise<SampleResult> => {
  try {
    return await runOnce(fixture, sample, model, apiKey);
  } catch (error) {
    const checks = [{ name: "error", pass: false, detail: String(error) }];
    return { id: fixture.id, sample, summary: "", checks, pass: false };
  }
};

const runOnce = async (
  fixture: SideChatSummaryCase,
  sample: number,
  model: string,
  apiKey: string,
): Promise<SampleResult> => {
  const writer = parseWriter(await apiCall(writerBody(fixture, model), apiKey));
  const summary = writer.text ?? "";
  const judge = parseYesNo(await apiCall(judgeBody(fixture, summary, model), apiKey));
  const checks = gradeSummary(fixture, summary, judge);
  return { id: fixture.id, sample, summary, checks, pass: checks.every((check) => check.pass) };
};

const main = async () => {
  const { values } = NodeUtil.parseArgs({
    options: {
      out: { type: "string" },
      model: { type: "string", default: MODEL },
      case: { type: "string", multiple: true },
      samples: { type: "string", default: "3" },
      baseline: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.out) throw new Error("Use --out <directory>.");
  const fixtures = selectedCases(values.case);
  const model = values.model!;
  const samples = Number(values.samples);
  if (!Number.isInteger(samples) || samples < 1)
    throw new Error("--samples must be a positive integer.");

  if (values["dry-run"]) {
    for (const fixture of fixtures) {
      console.log(
        JSON.stringify({
          id: fixture.id,
          writer: writerBody(fixture, model),
          judge: judgeBody(fixture, "<writer output>", model),
        }),
      );
    }
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Set ANTHROPIC_API_KEY or use --dry-run.");
  const results = await Promise.all(
    fixtures.flatMap((fixture) =>
      Array.from({ length: samples }, (_, sample) => run(fixture, sample + 1, model, apiKey)),
    ),
  );
  const baseline = values.baseline
    ? (JSON.parse(NodeFS.readFileSync(values.baseline, "utf8")) as Array<SampleResult>)
    : undefined;
  const summary = fixtures.map((fixture) => {
    const rows = results.filter((row) => row.id === fixture.id);
    const pass = rows.filter((row) => row.pass).length;
    const old = baseline?.filter((row) => row.id === fixture.id).filter((row) => row.pass).length;
    return {
      id: fixture.id,
      pass,
      total: rows.length,
      failed: rows.length - pass,
      casePass: pass * 2 > rows.length,
      ...(old === undefined ? {} : { baselinePass: old }),
    };
  });
  NodeFS.mkdirSync(values.out, { recursive: true });
  NodeFS.writeFileSync(`${values.out}/results.json`, JSON.stringify(results, null, 2));
  NodeFS.writeFileSync(`${values.out}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
};

if (import.meta.main) await main();
