import type {
  GitHubWorkflow,
  GitHubWorkflowListInput,
  GitHubWorkflowRunInput,
  GitHubWorkflowRunResult,
} from "@t3tools/contracts";
import { SourceControlProviderError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as GitHubCli from "./GitHubCli.ts";
import { parseDispatchWorkflow } from "./githubWorkflowYaml.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";

const WORKFLOWS_DIRECTORY = ".github/workflows";

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
    ) => Effect.Effect<{ readonly workflows: ReadonlyArray<GitHubWorkflow> }>;
    readonly run: (
      input: GitHubWorkflowRunInput,
    ) => Effect.Effect<GitHubWorkflowRunResult, SourceControlProviderError>;
  }
>()("t3/sourceControl/GitHubWorkflowService") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const github = yield* GitHubCli.GitHubCli;
  const path = yield* Path.Path;

  const list = Effect.fn("GitHubWorkflowService.list")(function* (input: GitHubWorkflowListInput) {
    const workflowsDirectory = path.join(input.cwd, WORKFLOWS_DIRECTORY);
    const entries = yield* fileSystem
      .readDirectory(workflowsDirectory)
      .pipe(Effect.orElseSucceed(() => []));
    const filenames = entries
      .filter((filename) => /\.ya?ml$/.test(filename))
      .toSorted((left, right) => left.localeCompare(right));

    const workflows = yield* Effect.forEach(
      filenames,
      (filename) =>
        fileSystem.readFileString(path.join(workflowsDirectory, filename)).pipe(
          Effect.map((contents) => parseDispatchWorkflow(contents, filename)),
          Effect.orElseSucceed(() => null),
        ),
      { concurrency: 8 },
    );
    return { workflows: workflows.filter((workflow) => workflow !== null) };
  });

  const run = Effect.fn("GitHubWorkflowService.run")(function* (input: GitHubWorkflowRunInput) {
    const dispatchOutput = yield* github
      .execute({
        cwd: input.cwd,
        args: workflowRunArguments(input),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: "github",
              operation: "runWorkflow",
              cwd: input.cwd,
              command: cause.command,
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.filename),
              detail: cause.detail,
              cause,
            }),
        ),
      );
    const dispatchRunUrl = extractRunUrl(`${dispatchOutput.stdout}\n${dispatchOutput.stderr}`);
    return dispatchRunUrl ? { url: dispatchRunUrl } : {};
  });

  return GitHubWorkflowService.of({ list, run });
});

export const layer = Layer.effect(GitHubWorkflowService, make);
