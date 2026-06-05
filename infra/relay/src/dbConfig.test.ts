import { describe, expect, it } from "vitest";

import { relayDatabaseMode } from "./dbConfig.ts";

describe("relayDatabaseMode", () => {
  it("uses the shared database only for production", () => {
    expect(relayDatabaseMode("prod")).toBe("shared-database");
    expect(relayDatabaseMode("dev_julius")).toBe("stage-branch");
    expect(relayDatabaseMode("preview")).toBe("stage-branch");
  });
});
