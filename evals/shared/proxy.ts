import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseToml, TomlError } from "smol-toml";

// Only the fields the evals read; Struct decoding ignores the rest of the Codex config.
const ProviderConfig = Schema.Struct({
  base_url: Schema.optional(Schema.String),
  http_headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  env_http_headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  env_key: Schema.optional(Schema.String),
  experimental_bearer_token: Schema.optional(Schema.String),
  requires_openai_auth: Schema.optional(Schema.Boolean),
});
const decodeCodexConfig = Schema.decodeUnknownEffect(
  Schema.Struct({
    model_provider: Schema.optional(Schema.String),
    model_providers: Schema.optional(Schema.Record(Schema.String, ProviderConfig)),
  }),
);
const decodeAuth = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ OPENAI_API_KEY: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
);

export class ProxyConfigError extends Schema.TaggedError<ProxyConfigError>()("ProxyConfigError", {
  problem: Schema.String,
}) {
  override get message(): string {
    return `${this.problem} The GPT evals call models through a CLIProxyAPI server set up as a custom model provider in Codex: set model_provider = "<name>" and add [model_providers.<name>] with base_url and its key.`;
  }
}

const fail = (problem: string) => Effect.fail(new ProxyConfigError({ problem }));
const optionalEnv = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.getOrUndefined));

/**
 * Reads the CLIProxyAPI provider from `$CODEX_HOME/config.toml` (default `~/.codex`): the one
 * `T3CODE_EVAL_MODEL_PROVIDER` names, else `model_provider` when it is custom, else `vibeproxy`.
 * Credentials stay in memory.
 */
export const proxyConfig = Effect.fn("proxyConfig")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home =
    (yield* optionalEnv("CODEX_HOME")) || path.join(yield* HostProcess.HomeDirectory, ".codex");
  const configPath = path.join(home, "config.toml");
  const isFile = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );
  if (!(yield* isFile(configPath))) return yield* fail(`No Codex config at ${configPath}.`);
  const source = yield* fs.readFileString(configPath);
  const parsed = yield* Effect.try({
    try: () => parseToml(source),
    // The parser's message quotes nearby source lines, which can contain credentials.
    catch: (error) =>
      error instanceof TomlError
        ? new ProxyConfigError({
            problem: `Invalid TOML at ${configPath} (line ${error.line}, column ${error.column}).`,
          })
        : new ProxyConfigError({ problem: `Could not parse ${configPath}.` }),
  });
  const config = yield* decodeCodexConfig(parsed);
  const providers = config.model_providers ?? {};
  const override = yield* optionalEnv("T3CODE_EVAL_MODEL_PROVIDER");
  const name =
    override ||
    (config.model_provider !== undefined && Object.hasOwn(providers, config.model_provider)
      ? config.model_provider
      : "vibeproxy");
  const provider = Object.hasOwn(providers, name) ? providers[name] : undefined;
  if (override && !provider) {
    return yield* fail(
      `T3CODE_EVAL_MODEL_PROVIDER names "${name}", but ${configPath} has no [model_providers.${name}].`,
    );
  }
  if (!provider) {
    return yield* fail(
      `${configPath} has no custom model provider to use (model_provider is ${config.model_provider === undefined ? "unset" : `"${config.model_provider}"`}).`,
    );
  }
  if (!provider.base_url) {
    return yield* fail(`[model_providers.${name}] in ${configPath} has no base_url.`);
  }

  const headers: Record<string, string> = { ...provider.http_headers };
  for (const [header, variable] of Object.entries(provider.env_http_headers ?? {})) {
    const value = yield* optionalEnv(variable);
    if (value === undefined) {
      return yield* fail(
        `[model_providers.${name}] in ${configPath} reads its ${header} header from ${variable}, which is not set.`,
      );
    }
    headers[header] = value;
  }
  let key = provider.env_key
    ? yield* optionalEnv(provider.env_key)
    : provider.experimental_bearer_token;
  if (provider.env_key && !key) {
    return yield* fail(
      `[model_providers.${name}] in ${configPath} reads its key from ${provider.env_key}, which is not set.`,
    );
  }
  const authPath = path.join(home, "auth.json");
  if (!key && provider.requires_openai_auth && (yield* isFile(authPath))) {
    const auth = yield* fs.readFileString(authPath).pipe(
      Effect.flatMap(decodeAuth),
      Effect.mapError(() => new ProxyConfigError({ problem: `Invalid JSON at ${authPath}.` })),
    );
    key = auth.OPENAI_API_KEY ?? undefined;
  }
  if (!key && provider.requires_openai_auth) {
    return yield* fail(
      `[model_providers.${name}] in ${configPath} sets requires_openai_auth, but ${authPath} has no OPENAI_API_KEY.`,
    );
  }
  if (key) headers.Authorization = `Bearer ${key}`;
  return { url: provider.base_url.replace(/\/+$/, ""), headers };
});
