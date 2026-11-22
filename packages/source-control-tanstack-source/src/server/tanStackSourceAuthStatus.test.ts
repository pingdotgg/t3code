import { describe, expect, it } from "vite-plus/test";

import { parseTanStackSourceAuthStatus } from "./tanStackSourceAuthStatus.ts";
import { effectiveAccount } from "./TanStackSourceSourceControlProvider.ts";

// Captured from src 0.6.2.
const SIGNED_IN = `source.tanstack.com
  ✓ Logged in to source.tanstack.com account alice (/home/alice/.config/src/hosts.json)
  - Active account: true
  - Git operations protocol: https
  - Token: tsp_****************************************
  ✓ Logged in to source.tanstack.com account bob (/home/alice/.config/src/hosts.json)
  - Active account: false
  - Git operations protocol: https
  - Token: tsp_****************************************
`;

const REFUSED_ENV_TOKEN = `source.tanstack.com
  X Failed to log in to source.tanstack.com using token (SRC_TOKEN)
  - Active account: true
  - The token in SRC_TOKEN is invalid.

  ✓ Logged in to source.tanstack.com account alice (/home/alice/.config/src/hosts.json)
  - Active account: false
  - Git operations protocol: https
  - Token: tsp_****************************************
`;

describe("parseTanStackSourceAuthStatus", () => {
  it("reads every login with its active flag, and never a token line", () => {
    const accounts = parseTanStackSourceAuthStatus(SIGNED_IN);
    expect(accounts).toEqual([
      {
        host: "source.tanstack.com",
        account: "alice",
        authenticated: true,
        active: true,
        error: null,
        environmentVariable: null,
      },
      {
        host: "source.tanstack.com",
        account: "bob",
        authenticated: true,
        active: false,
        error: null,
        environmentVariable: null,
      },
    ]);
    expect(effectiveAccount(accounts, undefined)?.account).toBe("alice");
    expect(effectiveAccount(accounts, "bob")?.account).toBe("bob");
    expect(effectiveAccount(accounts, "carol")?.account).toBe("alice");
  });

  it("keeps a refused SRC_TOKEN's reason and falls back to the saved login", () => {
    const accounts = parseTanStackSourceAuthStatus(REFUSED_ENV_TOKEN);
    expect(accounts[0]).toEqual({
      host: "source.tanstack.com",
      account: "",
      authenticated: false,
      active: true,
      error: "The token in SRC_TOKEN is invalid.",
      environmentVariable: "SRC_TOKEN",
    });
    expect(effectiveAccount(accounts, undefined)?.account).toBe("alice");
  });

  it("reads no login from a signed-out CLI", () => {
    expect(
      parseTanStackSourceAuthStatus(
        "You are not logged into any TanStack Source hosts. To log in, run: src auth login\n",
      ),
    ).toEqual([]);
  });
});
