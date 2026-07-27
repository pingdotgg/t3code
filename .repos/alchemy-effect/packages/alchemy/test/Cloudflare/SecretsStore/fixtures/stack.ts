import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import AsyncSecretWorker from "./async-worker.ts";
import EffectSecretWorker from "./effect-worker.ts";

/**
 * Deploys both invocation styles against ONE shared Secret (declared in
 * `secret.ts`):
 *
 * - {@link EffectSecretWorker} — `Cloudflare.SecretsStore.ReadSecret(secret)`
 *   inside the Worker init, binding provided via `ReadSecretBinding`;
 * - {@link AsyncSecretWorker} — the Secret declared on the Worker `env`,
 *   used from a plain async-style `fetch`.
 *
 * Extracted into its own stack file so it can be deployed by the suite AND
 * inspected directly, e.g.
 * `alchemy tail --stage test ./test/Cloudflare/SecretsStore/fixtures/stack.ts`.
 */
export default Alchemy.Stack(
  "SecretsStoreBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const effectWorker = yield* EffectSecretWorker;
    const asyncWorker = yield* AsyncSecretWorker;
    return {
      effect: effectWorker.url.as<string>(),
      async: asyncWorker.url.as<string>(),
    };
  }),
);
