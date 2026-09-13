import { DevinSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  buildDevinAcpSpawnInput,
  devinAcpSpawnArgs,
  DEVIN_DEFAULT_MODEL_SLUG,
  resolveDevinAcpBaseModelId,
} from "./DevinAcpSupport.ts";

const decodeSettings = Schema.decodeSync(DevinSettings);

describe("Devin ACP support", () => {
  it("starts the configurable Devin binary through the ACP command", () => {
    expect(devinAcpSpawnArgs("full-access")).toEqual(["acp"]);
    expect(
      buildDevinAcpSpawnInput(decodeSettings({ binaryPath: "custom-devin" }), "C:/workspace", {
        DEVIN_TEST: "1",
      }),
    ).toEqual({
      command: "custom-devin",
      args: ["acp"],
      cwd: "C:/workspace",
      env: { DEVIN_TEST: "1" },
    });
  });

  it("uses the product fallback only when no model is selected", () => {
    expect(resolveDevinAcpBaseModelId(undefined)).toBe(DEVIN_DEFAULT_MODEL_SLUG);
    expect(resolveDevinAcpBaseModelId("devin-4.6")).toBe("devin-4.6");
  });
});
