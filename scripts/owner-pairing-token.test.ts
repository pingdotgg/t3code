// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";

import {
  resolveOwnerPairingDbPath,
  resolveOwnerPairingState,
  resolveOwnerPairingUrl,
  seedOwnerPairingToken,
} from "./owner-pairing-token.ts";

describe("owner-pairing-token", () => {
  it("resolves the dev and userdata auth database paths", () => {
    const env = { T3CODE_HOME: "C:\\t3-home", T3CODE_OWNER_PAIRING_STATE: "dev" };

    assert.equal(resolveOwnerPairingState(env), "dev");
    assert.equal(
      resolveOwnerPairingDbPath(env),
      path.resolve("C:\\t3-home", "dev", "state.sqlite"),
    );
    assert.equal(
      resolveOwnerPairingDbPath({ T3CODE_HOME: "C:\\t3-home" }, "userdata"),
      path.resolve("C:\\t3-home", "userdata", "state.sqlite"),
    );
  });

  it("prints the stable Cloudflare pairing URL without putting the token in the query", () => {
    assert.equal(
      resolveOwnerPairingUrl({
        T3CODE_OWNER_PAIRING_TOKEN: "stable-token",
        T3CODE_PUBLIC_BASE_URL: "https://t3.example.com",
      }),
      "https://t3.example.com/pair#token=stable-token",
    );
  });

  it("upserts and re-arms a stable owner bootstrap pairing row", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "t3-owner-pairing-test-"));
    const dbPath = path.join(dir, "state.sqlite");

    seedOwnerPairingToken({
      token: "stable-token",
      dbPath,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });

    const db = new DatabaseSync(dbPath);
    try {
      const first = db
        .prepare(
          "SELECT credential, scopes, subject, consumed_at, revoked_at FROM auth_pairing_links",
        )
        .get() as {
        readonly credential: string;
        readonly scopes: string;
        readonly subject: string;
        readonly consumed_at: string | null;
        readonly revoked_at: string | null;
      };
      assert.deepStrictEqual(first, {
        credential: "stable-token",
        scopes:
          '["orchestration:read","orchestration:operate","terminal:operate","review:write","relay:read","access:read","access:write","relay:write"]',
        subject: "owner-bootstrap",
        consumed_at: null,
        revoked_at: null,
      });

      db.prepare("UPDATE auth_pairing_links SET consumed_at = ? WHERE credential = ?").run(
        "2026-01-01T00:00:00.000Z",
        "stable-token",
      );
    } finally {
      db.close();
    }

    seedOwnerPairingToken({ token: "stable-token", dbPath });

    const reopened = new DatabaseSync(dbPath);
    try {
      const rearmed = reopened
        .prepare("SELECT consumed_at FROM auth_pairing_links WHERE credential = ?")
        .get("stable-token") as { readonly consumed_at: string | null };
      assert.equal(rearmed.consumed_at, null);
    } finally {
      reopened.close();
    }
  });
});
