import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  TextGenerationService,
} from "./coreServices";
import { runProcess } from "./processRunner";

const COMMIT_OUTPUT_SCHEMA_JSON = {
  type: "object",
  properties: {
    subject: { type: "string" },
    body: { type: "string" },
  },
  required: ["subject", "body"],
  additionalProperties: false,
} as const;

const PR_OUTPUT_SCHEMA_JSON = {
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string" },
  },
  required: ["title", "body"],
  additionalProperties: false,
} as const;

function parseCommitOutput(raw: unknown): { subject: string; body: string } {
  if (!raw || typeof raw !== "object") {
    throw new Error("Codex returned a non-object commit message payload.");
  }
  const record = raw as Record<string, unknown>;
  const subject = typeof record.subject === "string" ? record.subject.trim() : "";
  const body = typeof record.body === "string" ? record.body : "";
  if (subject.length === 0) {
    throw new Error("Codex returned an empty commit subject.");
  }
  return { subject, body };
}

function parsePrOutput(raw: unknown): { title: string; body: string } {
  if (!raw || typeof raw !== "object") {
    throw new Error("Codex returned a non-object PR payload.");
  }
  const record = raw as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const body = typeof record.body === "string" ? record.body.trim() : "";
  if (title.length === 0 || body.length === 0) {
    throw new Error("Codex returned an invalid PR title/body payload.");
  }
  return { title, body };
}

function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

async function writeTempFile(prefix: string, content: string): Promise<string> {
  const filePath = path.join(
    os.tmpdir(),
    `t3code-${prefix}-${process.pid}-${randomUUID()}.tmp`,
  );
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Best-effort cleanup.
  }
}

function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

async function runCodexJson<T>({
  cwd,
  prompt,
  outputSchemaJson,
  parse,
}: {
  cwd: string;
  prompt: string;
  outputSchemaJson: object;
  parse: (raw: unknown) => T;
}): Promise<T> {
  const schemaPath = await writeTempFile(
    "codex-schema",
    JSON.stringify(outputSchemaJson),
  );
  const outputPath = await writeTempFile("codex-output", "");

  try {
    await runProcess(
      "codex",
      [
        "exec",
        "--ephemeral",
        "-s",
        "read-only",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        "-",
      ],
      {
        cwd,
        timeoutMs: 180_000,
        stdin: prompt,
      },
    );

    const rawOutput = (await fs.readFile(outputPath, "utf8")).trim();
    if (rawOutput.length === 0) {
      throw new Error("Codex returned an empty response.");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawOutput);
    } catch {
      throw new Error("Codex returned invalid JSON output.");
    }

    return parse(parsedJson);
  } finally {
    await Promise.all([safeUnlink(schemaPath), safeUnlink(outputPath)]);
  }
}

export class CodexTextGenerator implements TextGenerationService {
  async generateCommitMessage(
    input: CommitMessageGenerationInput,
  ): Promise<CommitMessageGenerationResult> {
    const prompt = [
      "You write concise git commit messages.",
      "Return a JSON object with keys: subject, body.",
      "Rules:",
      "- subject must be imperative, <= 72 chars, and no trailing period",
      "- body can be empty string or short bullet points",
      "- capture the primary user-visible or developer-visible change",
      "",
      `Branch: ${input.branch ?? "(detached)"}`,
      "",
      "Staged files:",
      limitSection(input.stagedSummary, 6_000),
      "",
      "Staged patch:",
      limitSection(input.stagedPatch, 40_000),
    ].join("\n");

    const generated = await runCodexJson({
      cwd: input.cwd,
      prompt,
      outputSchemaJson: COMMIT_OUTPUT_SCHEMA_JSON,
      parse: (raw) => parseCommitOutput(raw),
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
    };
  }

  async generatePrContent(
    input: PrContentGenerationInput,
  ): Promise<PrContentGenerationResult> {
    const prompt = [
      "You write GitHub pull request content.",
      "Return a JSON object with keys: title, body.",
      "Rules:",
      "- title should be concise and specific",
      "- body must be markdown and include headings '## Summary' and '## Testing'",
      "- under Summary, provide short bullet points",
      "- under Testing, include bullet points with concrete checks or 'Not run' where appropriate",
      "",
      `Base branch: ${input.baseBranch}`,
      `Head branch: ${input.headBranch}`,
      "",
      "Commits:",
      limitSection(input.commitSummary, 12_000),
      "",
      "Diff stat:",
      limitSection(input.diffSummary, 12_000),
      "",
      "Diff patch:",
      limitSection(input.diffPatch, 40_000),
    ].join("\n");

    const generated = await runCodexJson({
      cwd: input.cwd,
      prompt,
      outputSchemaJson: PR_OUTPUT_SCHEMA_JSON,
      parse: (raw) => parsePrOutput(raw),
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  }
}
