import { describe, expect, it } from "vite-plus/test";

import { devinModelsFromCatalog, parseDevinAuthStatus } from "./DevinProvider.ts";

const SAMPLE_MODELS_JSON = {
  families: [
    {
      family_uid: "swe-2",
      slug: "swe-2",
      aliases: ["swe"],
      variants: [
        { model_uid: "swe-2-high", label: "SWE-2 High", is_new: true },
        { model_uid: "swe-2-medium", label: "SWE-2 Medium" },
        { model_uid: "swe-2-max", label: "SWE-2 Max" },
      ],
    },
    {
      family_uid: "devin-core",
      slug: "devin-core",
      aliases: ["adaptive"],
      variants: [{ model_uid: "adaptive", label: "Adaptive" }],
    },
  ],
};

describe("devinModelsFromCatalog", () => {
  it("flattens families into ServerProviderModel entries", () => {
    const models = devinModelsFromCatalog(SAMPLE_MODELS_JSON);
    expect(models.map((model) => model.slug)).toEqual([
      "swe-2-high",
      "swe-2-medium",
      "swe-2-max",
      "adaptive",
    ]);

    const sweHigh = models[0];
    expect(sweHigh).toMatchObject({
      name: "SWE-2 High",
      subProvider: "swe-2",
      aliases: ["swe"],
      badge: "new",
      isCustom: false,
      isDefault: false,
    });
  });

  it("marks adaptive as the default model", () => {
    const models = devinModelsFromCatalog(SAMPLE_MODELS_JSON);
    expect(models.find((model) => model.slug === "adaptive")?.isDefault).toBe(true);
  });

  it("returns an empty list for missing or malformed input", () => {
    expect(devinModelsFromCatalog(undefined)).toEqual([]);
    expect(devinModelsFromCatalog({})).toEqual([]);
    expect(
      devinModelsFromCatalog({ families: [{ variants: [{ model_uid: "  ", label: "x" }] }] }),
    ).toEqual([]);
  });
});

describe("parseDevinAuthStatus", () => {
  it("marks a logged-in CLI as authenticated", () => {
    const result = parseDevinAuthStatus({
      code: 0,
      stdout:
        "Logged in (via Devin).\n  Name:              adam\n  Email:             adam@example.com\n",
      stderr: "",
    });
    expect(result.status).toBe("ready");
    expect(result.auth.status).toBe("authenticated");
    expect(result.auth.email).toBe("adam@example.com");
  });

  it("marks a logged-out CLI as unauthenticated", () => {
    const result = parseDevinAuthStatus({
      code: 1,
      stdout: "",
      stderr: "Not logged in.",
    });
    expect(result.status).toBe("error");
    expect(result.auth.status).toBe("unauthenticated");
  });

  it("treats an unrecognized zero-exit output as ready with unknown auth", () => {
    const result = parseDevinAuthStatus({ code: 0, stdout: "something else", stderr: "" });
    expect(result.status).toBe("ready");
    expect(result.auth.status).toBe("unknown");
  });
});
