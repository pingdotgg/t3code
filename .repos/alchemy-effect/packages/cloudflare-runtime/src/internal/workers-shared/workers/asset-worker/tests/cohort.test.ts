// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { describe, it, vi } from "vitest";
import { COHORT_LOOKUP_TIMEOUT_MS, lookupCohort } from "../src/worker.ts";
import type { Env } from "../src/worker.ts";
import type { AccountCohortQuerierBinding } from "../worker-configuration.d.ts";

function makeEnv(
  querier?: Partial<AccountCohortQuerierBinding>,
): Pick<Env, "ACCOUNT_COHORT_QUERIER"> {
  return {
    ACCOUNT_COHORT_QUERIER: querier as AccountCohortQuerierBinding | undefined,
  };
}

describe("[Asset Worker] lookupCohort", () => {
  it("calls querier with account ID as string", async ({ expect }) => {
    const lookupMock = vi.fn().mockResolvedValue({
      ok: true,
      result: "ent",
      meta: { workersVersion: "test" },
    });

    const result = await lookupCohort(
      makeEnv({ lookupAccountCohort: lookupMock }) as Env,
      42,
    );

    expect(result).toBe("ent");
    expect(lookupMock).toHaveBeenCalledWith("42");
  });

  it("returns null when result is ok:false", async ({ expect }) => {
    const result = await lookupCohort(
      makeEnv({
        lookupAccountCohort: () =>
          Promise.resolve({
            ok: false as const,
            errors: [
              { name: "Error", message: "invalid account", code: "ERR" },
            ],
          }),
      }) as Env,
      42,
    );

    expect(result).toBeNull();
  });

  it("returns null when result is null", async ({ expect }) => {
    const result = await lookupCohort(
      makeEnv({
        lookupAccountCohort: () =>
          Promise.resolve({
            ok: true as const,
            result: null,
            meta: { workersVersion: "test" },
          }),
      }) as Env,
      42,
    );

    expect(result).toBeNull();
  });

  it("times out after COHORT_LOOKUP_TIMEOUT_MS", async ({ expect }) => {
    const result = await lookupCohort(
      makeEnv({
        lookupAccountCohort: () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  ok: true as const,
                  result: "ent",
                  meta: { workersVersion: "test" },
                }),
              COHORT_LOOKUP_TIMEOUT_MS * 2,
            );
          }),
      }) as Env,
      42,
    );

    expect(result).toBeNull();
  });
});
