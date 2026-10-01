import type {
  EnvironmentId,
  ServerSettingsPatch,
  UsageModelPriceOverride,
} from "@t3tools/contracts";

export interface UsagePriceTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly prices: Readonly<Record<string, UsageModelPriceOverride>> | null;
  readonly unavailable: string | null;
}

export interface UsagePriceChange {
  readonly model: string;
  readonly price: UsageModelPriceOverride | null;
}

export type UsagePriceWriteResult =
  | { readonly status: "saved" }
  | { readonly status: "failed"; readonly error: string };

/** Each destination settles independently; retry callers pass only the failed destinations. */
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
      if (target.unavailable !== null) {
        result = { status: "failed", error: target.unavailable };
      } else {
        try {
          const changes = input.changes.get(target.environmentId) ?? [];
          const saved =
            changes.length === 0
              ? { _tag: "Success" as const }
              : await input.write({
                  environmentId: target.environmentId,
                  input: {
                    patch: {
                      usagePriceOverrides: Object.fromEntries(
                        changes.map((change) => [change.model, change.price]),
                      ),
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
