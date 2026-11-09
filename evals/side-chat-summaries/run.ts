#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off - Eval runner uses Node's file, HTTP and stdout boundaries.
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import { SIDE_CHAT_NOTE_MAX_CHARS } from "@t3tools/contracts";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { buildSideChatTextPrompt } from "@t3tools/provider-core/server/textGenerationPrompts";
import { buildSideChatOutcomeInput } from "../../apps/server/src/orchestration-v2/sideChat/notes.ts";
import { buildSideChatSummarizerInput } from "../../apps/server/src/orchestration-v2/sideChat/sideChatText.ts";
import {
  sideChatOutcomeCases,
  sideChatSummaryCases,
  type SideChatOutcomeCase,
  type SideChatSummaryCase,
} from "./cases.ts";
import { proxyConfig } from "../shared/proxy.ts";

const MODEL = "claude-haiku-4-5";
const MAX_EVAL_CHARS = 1_800;

type WriterResult = { readonly text: string | null };
type Check = { readonly name: string; readonly pass: boolean; readonly detail: string };
type SampleResult = {
  readonly id: string;
  readonly sample: number;
  readonly summary: string;
  readonly judgeOutput: string;
  readonly checks: ReadonlyArray<Check>;
  readonly pass: boolean;
};
type EvalCase = SideChatSummaryCase | SideChatOutcomeCase;

const ending = /[.!?](?:["'”’)]*)$/;

export const parseYesNo = (text: string): boolean | null => {
  const answer = text
    .trim()
    .match(/^(?:\*\*)?\s*(?:the answer is\s*|answer\s*:?\s*)?(YES|NO)\b/i)?.[1]
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

const outcomeInput = (fixture: SideChatOutcomeCase) =>
  buildSideChatOutcomeInput({
    excerpt: fixture.excerpt,
    messages: fixture.messages,
    childNotes: [],
    previousNote: null,
  });

const writerBody = (fixture: EvalCase, model: string) => {
  const prompt = buildSideChatTextPrompt({
    kind: fixture.kind,
    prompt: fixture.kind === "opening_summary" ? summarizerInput(fixture) : outcomeInput(fixture),
  });
  return {
    model,
    max_tokens: 4_000,
    system: prompt.prompt,
    messages: [{ role: "user", content: "Return the requested JSON summary." }],
  };
};

const judgeBody = (fixture: EvalCase, summary: string, model: string) => ({
  model,
  max_tokens: 40,
  thinking: { type: "disabled" },
  system: "Evaluate the rubric using only the note. Return exactly YES or NO with no explanation.",
  messages: [
    {
      role: "user",
      content: `Rubric: ${fixture.rubric}\nThe ${fixture.kind === "opening_summary" ? "summary" : "note"} is:\n${fixture.kind === "opening_summary" && fixture.judgeChars !== null ? summary.slice(0, fixture.judgeChars) : summary}\n\nDoes it pass the rubric? Answer YES or NO.`,
    },
  ],
});

type ApiAuth = { readonly apiKey: string; readonly proxy?: ReturnType<typeof proxyConfig> };

const apiCall = async (body: unknown, auth: ApiAuth): Promise<string> => {
  const response = await fetch(`${auth.proxy?.url ?? "https://api.anthropic.com/v1"}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(auth.apiKey ? { "x-api-key": auth.apiKey } : {}),
      ...auth.proxy?.headers,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Anthropic API ${response.status}: ${await response.text()}`);
  const json = (await response.json()) as { content?: Array<{ text?: string }> };
  if (json.content === undefined)
    throw new Error(`Anthropic response missing content: ${JSON.stringify(json)}`);
  return json.content.map((part) => part.text ?? "").join("");
};

const parseWriter = (text: string): WriterResult => {
  const json = JSON.parse(extractJsonObject(text)) as WriterResult;
  return { text: typeof json.text === "string" ? json.text.trim() : null };
};

const gradeOutcomeNote = (summary: string, judge: boolean | null): ReadonlyArray<Check> => [
  {
    name: "judge",
    pass: judge === true,
    detail: "Haiku rubric",
  },
  {
    name: "length",
    pass: true,
    detail: `${summary.length}/${SIDE_CHAT_NOTE_MAX_CHARS} characters`,
  },
  {
    name: "no-invented-belief",
    pass: !/\b(?:think|thought|believe|believed|believes|assum)\w*\b/i.test(summary),
    detail: "does not attribute a belief to the learner",
  },
];

const selectedCases = (ids: string[] | undefined): ReadonlyArray<EvalCase> => {
  const allCases = [...sideChatSummaryCases, ...sideChatOutcomeCases];
  const selected =
    ids === undefined ? allCases : allCases.filter((entry) => ids.includes(entry.id));
  if (selected.length === 0) throw new Error("No case matches --case.");
  return selected;
};

const run = async (
  fixture: EvalCase,
  sample: number,
  model: string,
  auth: ApiAuth,
): Promise<SampleResult> => {
  try {
    return await runOnce(fixture, sample, model, auth);
  } catch (error) {
    const checks = [{ name: "error", pass: false, detail: String(error) }];
    return { id: fixture.id, sample, summary: "", judgeOutput: "", checks, pass: false };
  }
};

const runOnce = async (
  fixture: EvalCase,
  sample: number,
  model: string,
  auth: ApiAuth,
): Promise<SampleResult> => {
  const writer = parseWriter(await apiCall(writerBody(fixture, model), auth));
  const summary = writer.text ?? "";
  const judgeOutput = await apiCall(judgeBody(fixture, summary, model), auth);
  const judge = parseYesNo(judgeOutput);
  const checks =
    fixture.kind === "opening_summary"
      ? gradeSummary(fixture, summary, judge)
      : gradeOutcomeNote(summary, judge);
  return {
    id: fixture.id,
    sample,
    summary,
    judgeOutput,
    checks,
    pass: checks.every((check) => check.pass),
  };
};

const main = async () => {
  const { values } = NodeUtil.parseArgs({
    options: {
      out: { type: "string" },
      model: { type: "string", default: MODEL },
      case: { type: "string", multiple: true },
      samples: { type: "string", default: "3" },
      baseline: { type: "string" },
      proxy: { type: "string" },
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
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const proxySource = values.proxy ?? (apiKey ? undefined : "pool");
  if (proxySource !== undefined && proxySource !== "pool" && proxySource !== "vibeproxy") {
    throw new Error("--proxy must be pool or vibeproxy.");
  }
  const auth: ApiAuth = {
    apiKey: proxySource === undefined ? apiKey : "",
    ...(proxySource === undefined ? {} : { proxy: proxyConfig(proxySource) }),
  };
  const results = await Promise.all(
    fixtures.flatMap((fixture) =>
      Array.from({ length: samples }, (_, sample) => run(fixture, sample + 1, model, auth)),
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
