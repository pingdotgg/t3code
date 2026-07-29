import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Vault } from "./Vault.ts";

/**
 * Shared scaffolding for the Glacier runtime bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, makeGlacierVaultHttpBinding({ … }))` over the
 * builder below. Everything except the operation and the IAM action list is
 * boilerplate: Glacier's REST API scopes every data-plane operation to a
 * vault, so the runtime callable injects the bound {@link Vault}'s name (and
 * the `-` account-id path segment, meaning "the account that signed the
 * request") and the deploy-time half grants `actions` on the vault's ARN.
 */
export const makeGlacierVaultHttpBinding = <
  I extends { accountId: string; vaultName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Glacier.UploadArchive`. */
  tag: string;
  /**
   * The distilled operation; `accountId` (always `-`) and `vaultName` are
   * injected from the bound vault.
   */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the vault ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (vault: Vault) {
      const vaultName = yield* vault.vaultName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${vault}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${vault.vaultArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${vault.LogicalId})`)(function* (
        request?: Omit<I, "accountId" | "vaultName">,
      ) {
        return yield* op({
          ...request,
          accountId: "-",
          vaultName: yield* vaultName,
        } as I);
      });
    });
  });
