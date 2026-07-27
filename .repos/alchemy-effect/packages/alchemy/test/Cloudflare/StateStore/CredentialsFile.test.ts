import { isStateStoreCredentialsStale } from "@/Cloudflare/StateStore/CredentialsFile.ts";
import { describe, expect, it } from "alchemy-test";

const ACCOUNT_A = "c8eeff0e4f5ebeeedc8d9af2013d7997";
const ACCOUNT_B = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

/**
 * The cached Cloudflare state-store credentials encode an account (the `url`
 * is a `*.workers.dev` subdomain). {@link isStateStoreCredentialsStale} guards
 * against trusting a cache minted for a different account than the one now in
 * use — the bug where deploys silently read/write state in a previously
 * logged-in account.
 */
describe("isStateStoreCredentialsStale", () => {
  it("is fresh when the cached account matches the current account", () => {
    expect(
      isStateStoreCredentialsStale(
        { url: "https://s.workers.dev", authToken: "t", accountId: ACCOUNT_A },
        ACCOUNT_A,
      ),
    ).toBe(false);
  });

  it("is stale when the cached account differs from the current account", () => {
    expect(
      isStateStoreCredentialsStale(
        { url: "https://s.workers.dev", authToken: "t", accountId: ACCOUNT_A },
        ACCOUNT_B,
      ),
    ).toBe(true);
  });

  it("is stale for a legacy cache with no accountId", () => {
    expect(
      isStateStoreCredentialsStale(
        { url: "https://s.workers.dev", authToken: "t" },
        ACCOUNT_A,
      ),
    ).toBe(true);
  });
});
