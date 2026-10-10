/**
 * SkillsCli - runs the bundled `skills` CLI (vercel-labs/skills) through the
 * hidden `t3 skills-cli` subcommand, so installs write exactly what
 * `npx skills` would: the same folders, links and lock files.
 *
 * Arguments are built here from typed input only. Telemetry is off, git never
 * prompts, and stdin is closed, so the CLI can't wait on anyone.
 *
 * @module SkillsCli
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";

import * as ProcessRunner from "../processRunner.ts";

export class SkillsCliError extends Schema.TaggedError<SkillsCliError>()("SkillsCliError", {
  command: Schema.Literals(["add", "remove", "list"]),
  exitCode: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `The skills installer failed to ${this.command}.`;
  }
}

/** One entry of `add --json`. */
const AddResult = Schema.Struct({
  name: Schema.optional(Schema.String),
  status: Schema.Literals(["installed", "skipped", "failed"]),
  path: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  error: Schema.optional(Schema.NullOr(Schema.String)),
});
export type SkillsCliAddResult = typeof AddResult.Type;
const decodeAddResults = Schema.decodeUnknownEffect(fromLenientJson(Schema.Array(AddResult)));

export interface SkillsCliAddInput {
  readonly source: string;
  /** Skill names, or `*` for every skill in the source. */
  readonly skills: ReadonlyArray<string>;
  /** `skills` CLI agent ids, such as `universal` and `claude-code`. */
  readonly agents: ReadonlyArray<string>;
  /** Install into the home folders instead of `cwd`. */
  readonly global: boolean;
  /** Look through the whole repository, not just its root skill. */
  readonly fullDepth?: boolean;
  /** The project root, or the temp folder a preview unpacks into. */
  readonly cwd: string;
}

export interface SkillsCliRemoveInput {
  readonly skills: ReadonlyArray<string>;
  readonly global: boolean;
  readonly cwd: string;
}

export class SkillsCli extends Context.Service<
  SkillsCli,
  {
    /**
     * Install skills. Resolves with each skill's result, including failures the
     * CLI reports for the whole source (a result with no name).
     */
    readonly add: (
      input: SkillsCliAddInput,
    ) => Effect.Effect<ReadonlyArray<SkillsCliAddResult>, SkillsCliError>;
    /** Remove skills: their folders, every agent's link to them, and their lock entries. */
    readonly remove: (input: SkillsCliRemoveInput) => Effect.Effect<void, SkillsCliError>;
  }
>()("t3/skills/SkillsCli") {}

/** Fetching a large repository is slow; nothing here should take longer. */
const TIMEOUT = "3 minutes";
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const self = yield* resolveSelfInvocation();

  const run = (command: "add" | "remove", args: ReadonlyArray<string>, cwd: string) =>
    processRunner
      .run({
        command: self.command,
        args: [...selfInvocationArgs(self, ["skills-cli", command, ...args])],
        cwd,
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          DISABLE_TELEMETRY: "1",
          DO_NOT_TRACK: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
        // An empty stdin closes it, so a prompt the flags missed ends instead of waiting.
        stdin: "",
        timeout: TIMEOUT,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      })
      .pipe(Effect.mapError((cause) => new SkillsCliError({ command, cause })));

  const add: SkillsCli["Service"]["add"] = Effect.fn("SkillsCli.add")(function* (input) {
    const result = yield* run(
      "add",
      [
        input.source,
        "--skill",
        ...input.skills,
        "--agent",
        ...input.agents,
        ...(input.global ? ["--global"] : []),
        ...(input.fullDepth === true ? ["--full-depth"] : []),
        "--yes",
        "--json",
      ],
      input.cwd,
    );
    // A non-zero exit still prints the per-skill results when any were reached.
    return yield* decodeAddResults(result.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new SkillsCliError({ command: "add", exitCode: result.code ?? undefined, cause }),
      ),
    );
  });

  const remove: SkillsCli["Service"]["remove"] = Effect.fn("SkillsCli.remove")(function* (input) {
    const result = yield* run(
      "remove",
      [...input.skills, ...(input.global ? ["--global"] : []), "--yes"],
      input.cwd,
    );
    if (result.code !== 0) {
      return yield* new SkillsCliError({ command: "remove", exitCode: result.code ?? undefined });
    }
  });

  return SkillsCli.of({ add, remove });
});

export const layer = Layer.effect(SkillsCli, make);
