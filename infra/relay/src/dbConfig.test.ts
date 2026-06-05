import { describe, expect, it } from "vite-plus/test";

import { relayDatabaseMode } from "./dbConfig.ts";

describe("relayDatabaseMode", () => {
  it("uses the shared database only for production", () => {
    expect(relayDatabaseMode("prod")).toBe("shared-database");
    expect(relayDatabaseMode("dev_julius")).toBe("stage-branch");
    expect(relayDatabaseMode("preview")).toBe("stage-branch");
  });
});
