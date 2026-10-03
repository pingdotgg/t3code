import type {
  EnvironmentId,
  ServerSettingsPatch,
  UsageModelPriceOverride,
} from "@t3tools/contracts";

export interface UsagePriceTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly prices: Readonly<Record<string, UsageModelPriceOverride>> | null;
  /** Model mappings. `null` when they are not loaded or the server cannot store them. */
  readonly aliases: Readonly<Record<string, string>> | null;
  readonly unavailable: string | null;
}

/** `null` removes the model's custom price or mapping. */
export type UsagePriceChange =
  | { readonly model: string; readonly price: UsageModelPriceOverride | null }
  | { readonly model: string; readonly alias: string | null };

export type UsagePriceWriteResult =
  | { readonly status: "saved" }
  | { readonly status: "failed"; readonly error: string };

/**
 * Each destination settles independently; retry callers pass only the failed destinations.
 * Prices and mappings for one destination go out in a single patch.
 */
export async function writeUsagePrices(input: {
  readonly targets: readonly UsagePriceTarget[];
  readonly changes: ReadonlyMap<EnvironmentId, readonly UsagePriceChange[]>;
  readonly write: (input: {
    environmentId: EnvironmentId;
    input: { patch: ServerSettingsPatch };
  }) => Promise<{ readonly _tag: "Success" | "Failure" }>;
  readonly onResult: (environmentId: EnvironmentId, result: UsagePriceWriteResult) => void;
}) {
  await Promise.all(
    input.targets.map(async (target) => {
      let result: UsagePriceWriteResult;
      const changes = input.changes.get(target.environmentId) ?? [];
      const prices = changes.flatMap((change) =>
        "price" in change ? [[change.model, change.price] as const] : [],
      );
      const aliases = changes.flatMap((change) =>
        "alias" in change ? [[change.model, change.alias] as const] : [],
      );
      if (target.unavailable !== null) {
        result = { status: "failed", error: target.unavailable };
      } else if (aliases.length > 0 && target.aliases === null) {
        result = { status: "failed", error: "Update server to map models" };
      } else {
        try {
          const saved =
            changes.length === 0
              ? { _tag: "Success" as const }
              : await input.write({
                  environmentId: target.environmentId,
                  input: {
                    patch: {
                      ...(prices.length > 0
                        ? { usagePriceOverrides: Object.fromEntries(prices) }
                        : {}),
                      ...(aliases.length > 0
                        ? { usageModelAliases: Object.fromEntries(aliases) }
                        : {}),
                    },
                  },
                });
          result =
            saved._tag === "Success"
              ? { status: "saved" }
              : { status: "failed", error: "Could not save. Try again." };
        } catch {
          result = { status: "failed", error: "Could not save. Try again." };
        }
      }
      input.onResult(target.environmentId, result);
    }),
  );
}
