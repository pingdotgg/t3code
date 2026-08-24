import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { BackupVault } from "./BackupVault.ts";

/**
 * Shared scaffolding for AWS Backup HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two
 * builders below. Everything except the operation, the IAM action list, and
 * (for vault-scoped operations) the injected `BackupVaultName` is
 * boilerplate. The three `Start*Job` bindings inject an IAM role and a
 * PassRole grant, so they stay bespoke.
 */

/**
 * Build the impl Effect for an account-level operation (job monitoring,
 * protected-resource discovery, restore orchestration). The deploy-time half
 * grants `actions` on `*` — backup job / restore job / copy job IAM actions
 * do not support resource-level scoping.
 */
export const makeBackupAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Backup.ListBackupJobs`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });

/**
 * Build the impl Effect for a vault-scoped operation: the runtime callable
 * injects the bound {@link BackupVault}'s name as `BackupVaultName` and the
 * deploy-time half grants `actions` on the vault ARN (or `*` for
 * recovery-point actions, which authorize on the recovery point's underlying
 * resource ARN — an EBS/RDS snapshot ARN — and cannot be scoped to the
 * vault).
 */
export const makeBackupVaultHttpBinding = <
  I extends { BackupVaultName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Backup.DescribeRecoveryPoint`. */
  tag: string;
  /** The distilled operation; `BackupVaultName` is injected from the vault. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the vault ARN (or `*` — see `wildcardIam`). */
  actions: readonly string[];
  /**
   * Grant on `*` instead of the vault ARN. Recovery-point actions authorize
   * on the recovery point ARN (the underlying resource's snapshot ARN),
   * which is unknowable at deploy time.
   */
  wildcardIam?: boolean;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (vault: BackupVault) {
      const BackupVaultName = yield* vault.backupVaultName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${vault}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: options.wildcardIam
                  ? ["*"]
                  : [Output.interpolate`${vault.backupVaultArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${vault.LogicalId})`)(function* (
        request?: Omit<I, "BackupVaultName">,
      ) {
        return yield* op({
          ...request,
          BackupVaultName: yield* BackupVaultName,
        } as I);
      });
    });
  });
