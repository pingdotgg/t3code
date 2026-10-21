// @effect-diagnostics nodeBuiltinImport:off - one sha256 over two strings; Effect.Crypto is async and the digest feeds a synchronous Output.map.
import * as NodeCrypto from "node:crypto";

import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export interface RelayClientConfig {
  readonly url: string | undefined;
  readonly mobileTracingUrl: string;
  readonly mobileTracingDataset: string;
  readonly mobileTracingToken: Redacted.Redacted<string>;
  readonly clientTracingUrl: string;
  readonly clientTracingDataset: string;
  readonly clientTracingToken: Redacted.Redacted<string>;
  /** Alchemy hashes JSON inputs; Redacted hides token rotation, so hash the tokens without persisting secrets. */
  readonly tokenDigest: string;
}

export class RelayUrlUnavailableError extends Schema.TaggedError<RelayUrlUnavailableError>()(
  "RelayUrlUnavailableError",
  {},
) {
  override get message(): string {
    return "The relay worker has no URL yet; deploy again once the worker exists.";
  }
}

export const relayClientConfigEnv = (config: RelayClientConfig & { readonly url: string }) =>
  ({
    T3CODE_RELAY_URL: config.url,
    T3CODE_MOBILE_OTLP_TRACES_URL: config.mobileTracingUrl,
    T3CODE_MOBILE_OTLP_TRACES_DATASET: config.mobileTracingDataset,
    T3CODE_MOBILE_OTLP_TRACES_TOKEN: Redacted.value(config.mobileTracingToken),
    T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: config.clientTracingUrl,
    T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: config.clientTracingDataset,
    T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: Redacted.value(config.clientTracingToken),
  }) as const;

export class EnvValueNotSingleLineError extends Schema.TaggedError<EnvValueNotSingleLineError>()(
  "EnvValueNotSingleLineError",
  { name: Schema.String },
) {
  override get message(): string {
    return `${this.name} contains a line break and cannot be written as one .env assignment.`;
  }
}

/** Remove every duplicate: parseEnv takes the last value, which could otherwise override the update. */
export function reconcileEnvFile(
  contents: string,
  entries: Readonly<Record<string, string>>,
): string {
  const lines = contents === "" ? [] : contents.replace(/\n$/u, "").split("\n");
  const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u;
  const pending = new Map(Object.entries(entries));
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = assignment.exec(line);
    const name = match?.[1];
    if (match === null || name === undefined || !(name in entries)) {
      out.push(line);
      continue;
    }
    // Multiline assignments end at their closing quote; parseEnv consumes only the opening line if it is unclosed.
    const rawValue = match[2] ?? "";
    const quote = /^(['"`])/u.exec(rawValue)?.[1];
    if (quote !== undefined && !closesQuote(rawValue, quote)) {
      const closing = lines.findIndex((candidate, at) => at > index && candidate.includes(quote));
      if (closing !== -1) index = closing;
    }
    const value = pending.get(name);
    if (value !== undefined) {
      out.push(`${name}=${value}`);
      pending.delete(name);
    }
  }
  for (const [name, value] of pending) out.push(`${name}=${value}`);
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

const closesQuote = (value: string, quote: string): boolean =>
  value.length > 1 && value.slice(1).includes(quote);

export const tokenDigest = (tokens: ReadonlyArray<Redacted.Redacted<string>>): string =>
  NodeCrypto.createHash("sha256").update(tokens.map(Redacted.value).join("\n")).digest("hex");

export const PublishClientConfig = Alchemy.Action(
  "PublishClientConfig",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const override = yield* Config.String("T3CODE_RELAY_CLIENT_CONFIG_ENV").pipe(Config.option);
    const repoRootEnv = path.fromFileUrl(new URL("../../../.env", import.meta.url));
    const target = Option.isSome(override) ? override.value : yield* repoRootEnv;
    return Effect.fn(function* (input: RelayClientConfig) {
      const url = input.url;
      if (url === undefined) return yield* new RelayUrlUnavailableError();
      const entries = relayClientConfigEnv({ ...input, url });
      // Reject line breaks in provider values to prevent injected assignments.
      for (const [name, value] of Object.entries(entries)) {
        if (/[\r\n]/u.test(value)) return yield* new EnvValueNotSingleLineError({ name });
      }
      const existing = (yield* fs.exists(target)) ? yield* fs.readFileString(target) : "";
      yield* fs.writeFileString(target, reconcileEnvFile(existing, entries));
      yield* Console.log(`Wrote relay client configuration to ${target}`);
      return { path: target };
    });
  }),
);
