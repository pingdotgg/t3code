// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  GitHubWorkflow,
  GitHubWorkflowListInput,
  GitHubWorkflowRunInput,
  GitHubWorkflowRunResult,
} from "@t3tools/contracts";
import { GitHubWorkflowError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitHubCli from "./GitHubCli.ts";
import { parseDispatchWorkflow } from "./githubWorkflowYaml.ts";

const WORKFLOWS_DIRECTORY = ".github/workflows";

function errorMessage(cause: unknown, fallback: string): GitHubWorkflowError {
  return new GitHubWorkflowError({
    message: cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback,
  });
}

export function extractRunUrl(output: string): string | null {
  return output.match(/https?:\/\/[^\s]+\/actions\/runs\/\d+/)?.[0] ?? null;
}

export function workflowRunArguments(input: {
  readonly filename: string;
  readonly ref: string;
  readonly inputs: Readonly<Record<string, string>>;
}): ReadonlyArray<string> {
  const fieldArguments = Object.entries(input.inputs).flatMap(([name, value]) => [
    "-f",
    `${name}=${value}`,
  ]);
  return ["workflow", "run", input.filename, "--ref", input.ref, ...fieldArguments];
}

export class GitHubWorkflowService extends Context.Service<
  GitHubWorkflowService,
  {
    readonly list: (
      input: GitHubWorkflowListInput,
    ) => Effect.Effect<{ readonly workflows: ReadonlyArray<GitHubWorkflow> }, GitHubWorkflowError>;
    readonly run: (
      input: GitHubWorkflowRunInput,
    ) => Effect.Effect<GitHubWorkflowRunResult, GitHubWorkflowError>;
  }
>()("t3/sourceControl/GitHubWorkflowService") {}

export const make = Effect.gen(function* () {
  const github = yield* GitHubCli.GitHubCli;

  const list = Effect.fn("GitHubWorkflowService.list")(function* (input: GitHubWorkflowListInput) {
    const workflowsDirectory = NodePath.join(input.cwd, WORKFLOWS_DIRECTORY);
    const entries = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await NodeFSP.readdir(workflowsDirectory, { withFileTypes: true });
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
          throw cause;
        }
      },
      catch: (cause) => errorMessage(cause, "Failed to read GitHub workflows."),
    });

    const filenames = entries
      .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
      .map((entry) => entry.name)
      .toSorted((left, right) => left.localeCompare(right));

    const workflows = yield* Effect.forEach(
      filenames,
      (filename) =>
        Effect.tryPromise({
          try: async () => {
            const path = NodePath.join(workflowsDirectory, filename);
            return parseDispatchWorkflow(await NodeFSP.readFile(path, "utf8"), filename);
          },
          catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null)),
      { concurrency: 8 },
    );
    return { workflows: workflows.filter((workflow) => workflow !== null) };
  });

  const run = Effect.fn("GitHubWorkflowService.run")(function* (input: GitHubWorkflowRunInput) {
    if (NodePath.basename(input.filename) !== input.filename) {
      return yield* new GitHubWorkflowError({ message: "Invalid GitHub workflow filename." });
    }
    const discovered = yield* list({ cwd: input.cwd });
    const workflow = discovered.workflows.find((item) => item.filename === input.filename);
    if (!workflow) {
      return yield* new GitHubWorkflowError({
        message: "This workflow is unavailable or does not support manual dispatch.",
      });
    }
    const allowedInputs = new Set(workflow.inputs.map((item) => item.name));
    if (Object.keys(input.inputs).some((name) => !allowedInputs.has(name))) {
      return yield* new GitHubWorkflowError({
        message: "The workflow inputs are no longer valid.",
      });
    }
    for (const workflowInput of workflow.inputs) {
      const value = input.inputs[workflowInput.name];
      if (workflowInput.required && (!value || !value.trim())) {
        return yield* new GitHubWorkflowError({
          message: `The required workflow input '${workflowInput.name}' is missing.`,
        });
      }
      if (value !== undefined && workflowInput.options && !workflowInput.options.includes(value)) {
        return yield* new GitHubWorkflowError({
          message: `The workflow input '${workflowInput.name}' has an invalid option.`,
        });
      }
      if (
        value !== undefined &&
        workflowInput.type === "boolean" &&
        !/^(true|false)$/.test(value)
      ) {
        return yield* new GitHubWorkflowError({
          message: `The workflow input '${workflowInput.name}' must be true or false.`,
        });
      }
    }

    const dispatchOutput = yield* github
      .execute({
        cwd: input.cwd,
        args: workflowRunArguments(input),
      })
      .pipe(Effect.mapError((cause) => errorMessage(cause, "Failed to start GitHub workflow.")));
    const runUrl = extractRunUrl(`${dispatchOutput.stdout}\n${dispatchOutput.stderr}`);
    if (!runUrl) {
      return yield* new GitHubWorkflowError({
        message: "The GitHub CLI did not return the created workflow run URL.",
      });
    }
    return { url: runUrl };
  });

  return GitHubWorkflowService.of({ list, run });
});

export const layer = Layer.effect(GitHubWorkflowService, make);
