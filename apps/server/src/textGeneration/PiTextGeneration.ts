import { TextGenerationError, type PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  type BranchNameGenerationResult,
  type CommitMessageGenerationResult,
  type PrContentGenerationResult,
  type TextGenerationShape,
  type ThreadTitleGenerationResult,
} from "./TextGeneration.ts";
import { runPiRpcPrompt } from "../provider/Layers/PiRpc.ts";

function textGenerationError(operation: string, cause: unknown): TextGenerationError {
  return new TextGenerationError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function firstLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

export const makePiTextGeneration = (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<TextGenerationShape> =>
  Effect.succeed({
    generateCommitMessage: (input) =>
      Effect.tryPromise({
        try: async (): Promise<CommitMessageGenerationResult> => {
          const prompt = [
            "Write a concise git commit message for these staged changes.",
            "Return a subject line, then an optional body.",
            input.includeBranch
              ? "Also include a branch name on a final line starting with Branch:"
              : "",
            `Branch: ${input.branch ?? "unknown"}`,
            `Summary:\n${input.stagedSummary}`,
            `Patch:\n${input.stagedPatch}`,
          ]
            .filter(Boolean)
            .join("\n\n");
          const result = await runPiRpcPrompt({
            binaryPath: piSettings.binaryPath,
            args: ["--no-session", "--no-tools", "--no-builtin-tools"],
            message: prompt,
            cwd: input.cwd,
            environment,
            timeoutMs: 120_000,
          });
          const lines = result.text.trim().split(/\r?\n/);
          const subject = firstLine(result.text) || "Update files";
          const branchLine = lines.find((line) => line.toLowerCase().startsWith("branch:"));
          const branch = branchLine?.replace(/^branch:\s*/i, "").trim();
          const body = lines
            .filter((line) => line.trim() !== subject && line !== branchLine)
            .join("\n")
            .trim();
          return {
            subject,
            body,
            ...(input.includeBranch && branch ? { branch } : {}),
          };
        },
        catch: (cause) => textGenerationError("generateCommitMessage", cause),
      }),
    generatePrContent: (input) =>
      Effect.tryPromise({
        try: async (): Promise<PrContentGenerationResult> => {
          const prompt = [
            "Write a pull request title and body for these changes.",
            "Return the title on the first line, then the body.",
            `Base branch: ${input.baseBranch}`,
            `Head branch: ${input.headBranch}`,
            `Commit summary:\n${input.commitSummary}`,
            `Diff summary:\n${input.diffSummary}`,
            `Patch:\n${input.diffPatch}`,
          ].join("\n\n");
          const result = await runPiRpcPrompt({
            binaryPath: piSettings.binaryPath,
            args: ["--no-session", "--no-tools", "--no-builtin-tools"],
            message: prompt,
            cwd: input.cwd,
            environment,
            timeoutMs: 120_000,
          });
          const title = firstLine(result.text) || "Update";
          const body = result.text.replace(title, "").trim();
          return { title, body };
        },
        catch: (cause) => textGenerationError("generatePrContent", cause),
      }),
    generateBranchName: (input) =>
      Effect.tryPromise({
        try: async (): Promise<BranchNameGenerationResult> => {
          const result = await runPiRpcPrompt({
            binaryPath: piSettings.binaryPath,
            args: ["--no-session", "--no-tools", "--no-builtin-tools"],
            message: `Create a short kebab-case git branch name for this request. Return only the branch name.\n\n${input.message}`,
            cwd: input.cwd,
            environment,
            timeoutMs: 60_000,
          });
          return { branch: firstLine(result.text).replace(/[^a-zA-Z0-9/_-]/g, "") || "pi-update" };
        },
        catch: (cause) => textGenerationError("generateBranchName", cause),
      }),
    generateThreadTitle: (input) =>
      Effect.tryPromise({
        try: async (): Promise<ThreadTitleGenerationResult> => {
          const result = await runPiRpcPrompt({
            binaryPath: piSettings.binaryPath,
            args: ["--no-session", "--no-tools", "--no-builtin-tools"],
            message: `Create a concise chat title, five words or fewer. Return only the title.\n\n${input.message}`,
            cwd: input.cwd,
            environment,
            timeoutMs: 60_000,
          });
          return { title: firstLine(result.text) || "Pi Chat" };
        },
        catch: (cause) => textGenerationError("generateThreadTitle", cause),
      }),
  } satisfies TextGenerationShape);
