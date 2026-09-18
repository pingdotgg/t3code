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

/** The relay outputs a client (web, desktop, mobile) needs at build time. */
export interface RelayClientConfig {
  /** Undefined until the worker has been deployed once. */
  readonly url: string | undefined;
  readonly mobileTracingUrl: string;
  readonly mobileTracingDataset: string;
  readonly mobileTracingToken: Redacted.Redacted<string>;
  readonly clientTracingUrl: string;
  readonly clientTracingDataset: string;
  readonly clientTracingToken: Redacted.Redacted<string>;
  /**
   * Alchemy decides whether an Action runs by hashing `JSON.stringify` of its
   * input, and a Redacted stringifies as `<redacted>`, so a rotated token
   * alone would never re-run it. A digest of both tokens makes the input
   * change with them without persisting the secrets in the hash.
   */
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

/** Replaces or appends each `NAME=value` line, leaving unrelated lines alone. */
export function reconcileEnvFile(
  contents: string,
  entries: Readonly<Record<string, string>>,
): string {
  let next = contents;
  for (const [name, value] of Object.entries(entries)) {
    const entry = `${name}=${value}`;
    const pattern = new RegExp(`^${name}=.*$`, "mu");
    if (pattern.test(next)) {
      next = next.replace(pattern, entry);
      continue;
    }
    if (!next) {
      next = `${entry}\n`;
      continue;
    }
    next = `${next}${next.endsWith("\n") ? "" : "\n"}${entry}\n`;
  }
  return next;
}

/**
 * Writes the relay's client configuration into the repo-root `.env` so the
 * web, desktop, and mobile dev servers build against the stage just deployed.
 * An Action rather than post-deploy scripting: it takes the stack outputs as
 * input, so it runs only when one of them changed and is skipped on a no-op
 * deploy. Set `T3CODE_RELAY_CLIENT_CONFIG_ENV` to write elsewhere (CI does).
 */
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
      const existing = (yield* fs.exists(target)) ? yield* fs.readFileString(target) : "";
      yield* fs.writeFileString(
        target,
        reconcileEnvFile(existing, relayClientConfigEnv({ ...input, url })),
      );
      yield* Console.log(`Wrote relay client configuration to ${target}`);
      return { path: target };
    });
  }),
);
