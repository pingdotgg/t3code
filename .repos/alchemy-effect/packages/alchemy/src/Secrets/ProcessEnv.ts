import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { envKeys } from "./Log.ts";
import {
  resolveSecretsOption,
  type SecretsLayer,
  type SecretsOption,
} from "./Provider.ts";

export interface ProcessEnvOptions {
  /**
   * Leave the process environment out of this stack entirely. The entry
   * stays in the list but contributes nothing.
   * @default false
   */
  disabled?: boolean;
}

/** A `secrets` entry that loads the process environment. */
export class ProcessEnvProvider extends Data.TaggedClass(
  "alchemy/SecretProvider::ProcessEnv",
)<{ readonly layer: SecretsLayer }> {}

/**
 * The process environment as a secrets provider.
 *
 * It is implicit: every stack ends its `secrets` list with the shell, so a
 * variable exported in the terminal or by CI overrides every provider. List
 * it yourself to put it elsewhere, typically first so it becomes a fallback
 * that a secrets manager overrides, or pass `disabled: true` to leave it out:
 *
 * ```ts
 * secrets: [Secrets.ProcessEnv(), Doppler.Secrets({ project: "app", config: "prd" })]
 * secrets: [Doppler.Secrets({ project: "app", config: "prd" }), Secrets.ProcessEnv({ disabled: true })]
 * ```
 */
export const ProcessEnv = (options: SecretsOption<ProcessEnvOptions> = {}) =>
  new ProcessEnvProvider({
    layer: ConfigProvider.layerAdd(
      Effect.gen(function* () {
        const resolved = yield* resolveSecretsOption(options);
        if (resolved.disabled) return ConfigProvider.fromEnv({ env: {} });
        const environment = ConfigProvider.fromEnv({
          preserveEmptyStrings: true,
        });
        // A shell has far too many variables to list; the count is enough.
        const keys = yield* envKeys(environment);
        yield* Effect.logDebug(
          `Loaded ${keys.length} secrets from the process environment`,
        );
        return environment;
      }),
      { asPrimary: true },
    ),
  });
