import { describe, expect, it } from "vite-plus/test";

import { devinModelsFromCatalog, parseDevinAuthStatus } from "./DevinProvider.ts";

const SAMPLE_MODELS_JSON = {
  families: [
    {
      family_uid: "swe-2",
      family_label: "SWE-2",
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
      family_label: "Adaptive",
      slug: "devin-core",
      variants: [{ model_uid: "adaptive", label: "Adaptive" }],
    },
  ],
};

describe("devinModelsFromCatalog", () => {
  it("groups effort variants into one row per family", () => {
    const models = devinModelsFromCatalog(SAMPLE_MODELS_JSON);
    expect(models.map((model) => model.slug)).toEqual(["swe-2", "adaptive"]);

    const swe2 = models[0]!;
    expect(swe2).toMatchObject({
      name: "SWE-2",
      badge: "new",
      isCustom: false,
      isDefault: false,
    });
    // Family slug must not become `subProvider` — the picker strips that
    // prefix from the label, leaving bare effort names like "High".
    expect(swe2.subProvider).toBeUndefined();
    // Variant uids stay reachable as aliases so stored flat selections like
    // `swe-2-high` still resolve to the grouped row.
    expect(swe2.aliases).toEqual(["swe", "swe-2-high", "swe-2-medium", "swe-2-max"]);

    const effortDescriptor = swe2.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.id === "effort",
    );
    expect(effortDescriptor).toMatchObject({
      type: "select",
      label: "Reasoning",
    });
    expect(
      effortDescriptor?.type === "select" ? effortDescriptor.options.map((o) => o.id) : [],
    ).toEqual(["medium", "high", "max"]);
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
