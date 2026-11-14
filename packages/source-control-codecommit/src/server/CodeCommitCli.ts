import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Cache from "effect/Cache";
import * as Exit from "effect/Exit";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { settings } from "../shared/definition.ts";

const kind = "aws-codecommit";
export class CodeCommitError extends Schema.TaggedError<CodeCommitError>()("CodeCommitError", {
  reason: Schema.String,
  failureKind: Schema.optional(
    Schema.Literals(["authentication", "forbidden", "rate-limited", "not-found", "failed"]),
  ),
}) {
  override get message() {
    return this.reason;
  }
}
const requestKeySchema = Schema.fromJsonString(
  Schema.Struct({
    cwd: Schema.String,
    profile: Schema.String,
    region: Schema.String,
    accountId: Schema.optional(Schema.String),
    args: Schema.Array(Schema.String),
  }),
);
const encodeRequestKey = Schema.encodeSync(requestKeySchema);
const decodeRequestKey = Schema.decodeSync(requestKeySchema);
const decodeCallerAccount = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ Account: Schema.String })),
);
class AwsConfig extends Context.Service<
  AwsConfig,
  { readonly profile: string; readonly region: string; readonly accountId?: string }
>()("@t3tools/source-control-codecommit/server/CodeCommitCli/AwsConfig") {}
export const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const executeRaw = Effect.fn("CodeCommit.execute")(function* ({
    cwd,
    args,
    profile,
    region,
  }: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly profile: string;
    readonly region: string;
  }) {
    const result = yield* host.process.run({
      operation: "CodeCommit.execute",
      command: "aws",
      cwd,
      args: [
        ...args,
        "--output",
        "json",
        "--no-cli-pager",
        "--no-cli-auto-prompt",
        ...(profile ? ["--profile", profile] : []),
        ...(region ? ["--region", region] : []),
      ],
      env: { AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" },
      timeoutMs: 30_000,
      maxOutputBytes: 2_000_000,
      outputMode: "truncate",
      allowNonZeroExit: true,
      concurrency: { key: "source-control-codecommit", limit: 5 },
      classifyFailure: (stderr) =>
        /unable to locate credentials|expiredtoken|sso.*(?:expired|invalid)|accessdenied|unauthorized|invalidclienttokenid/iu.test(
          stderr,
        )
          ? "authentication"
          : null,
    });
    if (result.stdoutTruncated)
      return yield* new CodeCommitError({ reason: "AWS CLI response exceeded output limit" });
    if (result.exitCode !== 0) {
      const code = /An error occurred \(([A-Za-z0-9]+)\)/u.exec(result.stderr)?.[1];
      const failureKind = /AccessDenied|Unauthorized/iu.test(code ?? "")
        ? "forbidden"
        : /ExpiredToken|InvalidClientToken|UnrecognizedClient|TokenRefresh|SSO|credentials/iu.test(
              `${code ?? ""} ${result.stderr}`,
            )
          ? "authentication"
          : /Throttl|TooManyRequests|RequestLimitExceeded/iu.test(code ?? "")
            ? "rate-limited"
            : /DoesNotExist|NotFound/iu.test(code ?? "")
              ? "not-found"
              : "failed";
      return yield* new CodeCommitError({
        reason: code ? `AWS CodeCommit request failed (${code}).` : "AWS CLI request failed.",
        failureKind,
      });
    }
    if (result.stdoutInvalidUtf8)
      return yield* new CodeCommitError({ reason: "Invalid AWS CLI response" });
    return result.stdout;
  });
  const verifyAccount = Effect.fn("CodeCommit.verifyAccount")(function* (
    cwd: string,
    accountId: string,
  ) {
    const config = yield* AwsConfig;
    const raw = yield* executeRaw({ cwd, args: ["sts", "get-caller-identity"], ...config });
    const caller = yield* decodeCallerAccount(raw);
    if (caller.Account !== accountId)
      return yield* new CodeCommitError({
        reason: "The AWS profile changed accounts. Refresh the repository before continuing.",
        failureKind: "forbidden",
      });
  });
  const cache = yield* Cache.makeWith((key: string) => executeRaw(decodeRequestKey(key)), {
    capacity: 512,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? "3 seconds" : Duration.zero),
  });
  const execute = Effect.fn("CodeCommit.executeCached")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    region?: string,
  ) {
    const config = yield* AwsConfig;
    const input = {
      cwd,
      args,
      profile: config.profile,
      region: region ?? config.region,
      ...(config.accountId ? { accountId: config.accountId } : {}),
    };
    if (
      [
        "get-repository",
        "get-pull-request",
        "list-pull-requests",
        "get-caller-identity",
        "get-differences",
        "get-blob",
        "get-commit",
      ].includes(args[1] ?? "")
    ) {
      return yield* Cache.get(cache, encodeRequestKey(input));
    }
    if (
      args[1]?.startsWith("get-") ||
      args[1]?.startsWith("list-") ||
      args[1]?.startsWith("describe-") ||
      args[1] === "evaluate-pull-request-approval-rules"
    )
      return yield* executeRaw(input);
    if (config.accountId) yield* verifyAccount(cwd, config.accountId);
    yield* Cache.invalidateAll(cache);
    return yield* executeRaw(input).pipe(Effect.ensuring(Cache.invalidateAll(cache)));
  });
  const withConfig = Effect.fn("CodeCommit.withConfig")(function* <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) {
    const existing = yield* Effect.serviceOption(AwsConfig);
    if (Option.isSome(existing))
      return yield* effect.pipe(Effect.provideService(AwsConfig, existing.value));
    const current = yield* host.settings.get;
    const config = readSourceControlHostSettings(settings, current.sourceControlHosts[kind]);
    return yield* effect.pipe(
      Effect.provideService(AwsConfig, config),
      Effect.tapError(() => Cache.invalidateAll(cache)),
    );
  });
  const request = Effect.fn("CodeCommit.request")(function* <A, I>(
    cwd: string,
    args: ReadonlyArray<string>,
    schema: Schema.Codec<A, I, never, never>,
    region?: string,
  ) {
    const raw = yield* execute(cwd, args, region);
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(raw);
  });
  const provideConfig = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    config: { readonly profile: string; readonly region: string; readonly accountId?: string },
  ) => effect.pipe(Effect.provideService(AwsConfig, config));
  return {
    execute,
    request,
    withConfig,
    provideConfig,
    verifyAccount,
    configuration: Effect.map(AwsConfig, (config) => config),
    invalidate: Cache.invalidateAll(cache),
  };
});
