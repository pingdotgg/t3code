import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { VcsError } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import { readSourceControlHostSettings } from "@t3tools/source-control-core/client/definition";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

import * as TangledClient from "../client/definition.ts";

/** `tg` is one binary on PATH; nothing here installs or updates it. */
export const TANGLED_CLI = "tg";

const DEFAULT_TIMEOUT_MS = 30_000;

export class TangledCliError extends Schema.TaggedError<TangledCliError>()("TangledCliError", {
  cwd: Schema.String,
  detail: Schema.String,
  reason: Schema.optional(
    Schema.Literals(["missing-cli", "authentication", "invalid-response", "failed"]),
  ),
  cause: Schema.optional(Schema.Defect()),
}) {}

/** `tg auth status --json` names the signed-in account, and nothing else when logged out. */
export const TangledAuthStatusSchema = Schema.Struct({
  authenticated: Schema.Boolean,
  status: Schema.optional(Schema.String),
  did: Schema.optional(Schema.String),
  handle: Schema.optional(Schema.String),
});

/** `tg repo view --json` describes a repository the way `tg repo list --json` describes each. */
export const TangledRepositorySchema = Schema.Struct({
  name: Schema.String,
  uri: Schema.optional(Schema.String),
  author: Schema.optional(Schema.String),
  knot: Schema.optional(Schema.String),
  repoDid: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
});

/**
 * `tg` reports a failure as `Error: <message>` on stderr and exits non-zero. A leading
 * `warning:` line is advisory — `tg repo view` prints one when a repository has no pipelines — so
 * it is not what a caller is told went wrong.
 */
export function tangledErrorMessage(result: {
  readonly stderr: string;
  readonly stdout: string;
}): string | undefined {
  for (const text of [result.stderr, result.stdout]) {
    const line = text
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0 && !/^warning:/iu.test(entry));
    if (line !== undefined) return line.replace(/^error:\s*/iu, "");
  }
  return undefined;
}

const isTangledCliErrorSchema = Schema.is(TangledCliError);

export function isTangledCliError(cause: unknown): cause is TangledCliError {
  return isTangledCliErrorSchema(cause);
}

function fromVcsError(cwd: string, cause: VcsError): TangledCliError {
  if (cause._tag === "VcsProcessSpawnError") {
    return new TangledCliError({
      cwd,
      reason: "missing-cli",
      detail: "Tangled CLI (`tg`) is required but was not found on the server PATH.",
      cause,
    });
  }
  if (cause._tag === "VcsProcessExitError" && cause.failureKind === "authentication") {
    return new TangledCliError({
      cwd,
      reason: "authentication",
      detail: "Tangled CLI is not signed in. Run `tg auth login` and retry.",
      cause,
    });
  }
  return new TangledCliError({ cwd, reason: "failed", detail: "Tangled CLI failed.", cause });
}

export class TangledCli extends Context.Service<
  TangledCli,
  {
    /** Runs `tg <args> --json` and decodes stdout with `schema`. */
    readonly runJson: <S extends Schema.Codec<unknown, unknown, never, never>>(input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly schema: S;
    }) => Effect.Effect<S["Type"], TangledCliError>;
    /**
     * Runs `tg <args>` and reports only whether it succeeded, for a command whose output this
     * build does not read — creating a pull request, which answers in a shape nothing here needs.
     */
    readonly run: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
    }) => Effect.Effect<void, TangledCliError>;
  }
>()("@t3tools/source-control-tangled/server/TangledCli") {}

/**
 * The environment `tg` reads for the appview and the knot. Both go through the environment
 * rather than a flag: `tg` has a global `--appview`, but no global `--knot` — that flag exists
 * only on `repo create` — so an environment is what reaches every subcommand alike. A blank field
 * leaves the variable unset, which is what lets `tg` fall back to its own config.toml.
 */
function environmentEnv(knot: string, appview: string): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  if (appview.trim().length > 0) env.TG_APPVIEW = appview.trim();
  if (knot.trim().length > 0) env.TG_KNOT = knot.trim();
  return env;
}

export const make = Effect.gen(function* () {
  const { process, settings: hostSettings } = yield* SourceControlHost.SourceControlHost;

  /**
   * Read per call rather than once: a knot or appview saved in settings applies to the next
   * command without restarting the server. A settings read that fails falls back to the defaults
   * the schema already carries.
   */
  const environmentEnv_ = Effect.fn("TangledCli.environmentEnv")(function* () {
    const saved = yield* hostSettings.get.pipe(
      Effect.map((value) => value.sourceControlHosts[TangledClient.definition.kind]),
      Effect.orElseSucceed(() => undefined),
    );
    const { knot, appview } = readSourceControlHostSettings(TangledClient.settings, saved);
    return environmentEnv(knot, appview);
  });

  /**
   * Runs `tg` with the environment's appview and knot, and fails on a non-zero exit. The exit is
   * read here rather than by the host, because `tg` puts the reason it failed on stderr, where the
   * host's own failure detail does not carry it.
   */
  const invoke = Effect.fn("TangledCli.invoke")(function* (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
  }) {
    const env = yield* environmentEnv_();
    const result = yield* process
      .run({
        operation: "TangledCli.execute",
        command: TANGLED_CLI,
        args: input.args,
        cwd: input.cwd,
        env,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: 2_000_000,
        allowNonZeroExit: true,
      })
      .pipe(Effect.mapError((cause: VcsError) => fromVcsError(input.cwd, cause)));
    if (result.exitCode !== 0) {
      const detail = tangledErrorMessage(result) ?? `tg ${input.args[0] ?? ""} failed.`;
      const authentication = /invalid_grant|not authenticated|not logged in|session expired/iu.test(
        detail,
      );
      return yield* new TangledCliError({
        cwd: input.cwd,
        reason: authentication ? "authentication" : "failed",
        detail: authentication ? `${detail} Run \`tg auth login\` and retry.` : detail,
      });
    }
    return result.stdout;
  });

  const runJson: TangledCli["Service"]["runJson"] = (input) =>
    invoke({ cwd: input.cwd, args: [...input.args, "--json"] }).pipe(
      Effect.flatMap((stdout) => {
        const decoded = decodeJsonResult(input.schema)(stdout);
        if (Result.isSuccess(decoded)) return Effect.succeed(decoded.success);
        return Effect.fail(
          new TangledCliError({
            cwd: input.cwd,
            reason: "invalid-response",
            detail: `tg ${input.args[0] ?? ""} returned output this build does not read.`,
          }),
        );
      }),
    );

  const run: TangledCli["Service"]["run"] = (input) =>
    invoke({ cwd: input.cwd, args: input.args }).pipe(Effect.asVoid);

  return TangledCli.of({ runJson, run });
});

export const layer = Layer.effect(TangledCli, make);
