// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
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
const decodeCodexConfig = Schema.decodeUnknownSync(
  Schema.Struct({
    model_provider: Schema.optional(Schema.String),
    model_providers: Schema.optional(Schema.Record(Schema.String, ProviderConfig)),
  }),
);
const decodeAuth = Schema.decodeUnknownSync(
  Schema.Struct({ OPENAI_API_KEY: Schema.optional(Schema.NullOr(Schema.String)) }),
);

const fail = (message: string): never => {
  throw new Error(
    `${message} The GPT evals call models through a CLIProxyAPI server set up as a custom model provider in Codex: set model_provider = "<name>" and add [model_providers.<name>] with base_url and its key.`,
  );
};

/**
 * Reads the CLIProxyAPI provider from `$CODEX_HOME/config.toml` (default `~/.codex`): the one
 * `T3CODE_EVAL_MODEL_PROVIDER` names, else `model_provider` when it is custom, else `vibeproxy`.
 * Credentials stay in memory.
 */
export const proxyConfig = () => {
  const home = process.env.CODEX_HOME || NodePath.join(NodeOS.homedir(), ".codex");
  const path = NodePath.join(home, "config.toml");
  if (!NodeFS.statSync(path, { throwIfNoEntry: false })?.isFile()) {
    return fail(`No Codex config at ${path}.`);
  }
  let config;
  try {
    config = decodeCodexConfig(parseToml(NodeFS.readFileSync(path, "utf8")));
  } catch (error) {
    // The parser includes nearby source lines, which can contain credentials.
    if (error instanceof TomlError) {
      return fail(`Invalid TOML at ${path} (line ${error.line}, column ${error.column}).`);
    }
    throw error;
  }
  const providers = config.model_providers ?? {};
  const override = process.env.T3CODE_EVAL_MODEL_PROVIDER;
  const name =
    override ||
    (config.model_provider !== undefined && Object.hasOwn(providers, config.model_provider)
      ? config.model_provider
      : "vibeproxy");
  const provider = Object.hasOwn(providers, name) ? providers[name] : undefined;
  if (override && !provider) {
    return fail(
      `T3CODE_EVAL_MODEL_PROVIDER names "${name}", but ${path} has no [model_providers.${name}].`,
    );
  }
  if (!provider) {
    return fail(
      `${path} has no custom model provider to use (model_provider is ${config.model_provider === undefined ? "unset" : `"${config.model_provider}"`}).`,
    );
  }
  if (!provider.base_url) return fail(`[model_providers.${name}] in ${path} has no base_url.`);

  const headers: Record<string, string> = { ...provider.http_headers };
  for (const [header, variable] of Object.entries(provider.env_http_headers ?? {})) {
    const value = process.env[variable];
    if (value === undefined) {
      return fail(
        `[model_providers.${name}] in ${path} reads its ${header} header from ${variable}, which is not set.`,
      );
    }
    headers[header] = value;
  }
  let key = provider.env_key ? process.env[provider.env_key] : provider.experimental_bearer_token;
  if (provider.env_key && !key) {
    return fail(
      `[model_providers.${name}] in ${path} reads its key from ${provider.env_key}, which is not set.`,
    );
  }
  const authPath = NodePath.join(home, "auth.json");
  if (
    !key &&
    provider.requires_openai_auth &&
    NodeFS.statSync(authPath, { throwIfNoEntry: false })?.isFile()
  ) {
    try {
      key =
        decodeAuth(JSON.parse(NodeFS.readFileSync(authPath, "utf8"))).OPENAI_API_KEY ?? undefined;
    } catch (error) {
      if (error instanceof SyntaxError) return fail(`Invalid JSON at ${authPath}.`);
      throw error;
    }
  }
  if (!key && provider.requires_openai_auth) {
    return fail(
      `[model_providers.${name}] in ${path} sets requires_openai_auth, but ${authPath} has no OPENAI_API_KEY.`,
    );
  }
  if (key) headers.Authorization = `Bearer ${key}`;
  return { url: provider.base_url.replace(/\/+$/, ""), headers };
};
