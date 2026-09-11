import type { EnvironmentId } from "@t3tools/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveAutoBalanceProviderStatuses,
  environmentSupportsModelSelection,
  isAutoBalanceRoutableEnvironment,
  isProviderSnapshotRoutable,
  shouldResetAutoBalanceRouting,
} from "./autoBalanceProviders";

const primaryEnv = "env-primary" as EnvironmentId;
const secondaryEnv = "env-secondary" as EnvironmentId;

function model(slug: string, aliases: string[] = []): ServerProviderModel {
  return {
    slug,
    name: slug,
    ...(aliases.length > 0 ? { aliases } : {}),
    isCustom: false,
    capabilities: {},
  } as ServerProviderModel;
}

function provider(input: {
  instanceId: string;
  driver?: string;
  enabled?: boolean;
  installed?: boolean;
  status?: ServerProvider["status"];
  auth?: ServerProvider["auth"]["status"];
  availability?: ServerProvider["availability"];
  models?: ServerProviderModel[];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver ?? input.instanceId),
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: null,
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: input.auth ?? "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
  };
}

describe("isAutoBalanceRoutableEnvironment", () => {
  it("accepts connected environments with default weight", () => {
    expect(
      isAutoBalanceRoutableEnvironment({
        connectionPhase: "connected",
        environmentId: primaryEnv,
        weights: {},
      }),
    ).toBe(true);
  });

  it("rejects disconnected environments", () => {
    expect(
      isAutoBalanceRoutableEnvironment({
        connectionPhase: "reconnecting",
        environmentId: primaryEnv,
        weights: {},
      }),
    ).toBe(false);
  });

  it("rejects environments opted out via zero weight", () => {
    expect(
      isAutoBalanceRoutableEnvironment({
        connectionPhase: "connected",
        environmentId: primaryEnv,
        weights: { [primaryEnv as string]: 0 },
      }),
    ).toBe(false);
  });
});

describe("isProviderSnapshotRoutable", () => {
  it("accepts a healthy snapshot", () => {
    expect(isProviderSnapshotRoutable(provider({ instanceId: "codex" }))).toBe(true);
  });

  it.each([
    ["error status", { status: "error" as const }],
    ["unauthenticated", { auth: "unauthenticated" as const }],
    ["disabled", { enabled: false }],
    ["not installed", { installed: false }],
    ["unavailable shadow", { availability: "unavailable" as const }],
  ])("rejects a snapshot with %s", (_label, override) => {
    expect(isProviderSnapshotRoutable(provider({ instanceId: "codex", ...override }))).toBe(false);
  });
});

describe("environmentSupportsModelSelection", () => {
  const codex = ProviderInstanceId.make("codex");
  const codexDriver = ProviderDriverKind.make("codex");

  it("matches an exact instance, driver, and model", () => {
    expect(
      environmentSupportsModelSelection({
        providers: [provider({ instanceId: "codex", models: [model("gpt-5")] })],
        instanceId: codex,
        driver: codexDriver,
        model: "gpt-5",
      }),
    ).toBe(true);
  });

  it("rejects an environment missing the selected model", () => {
    expect(
      environmentSupportsModelSelection({
        providers: [provider({ instanceId: "codex", models: [model("gpt-5")] })],
        instanceId: codex,
        driver: codexDriver,
        model: "gpt-6",
      }),
    ).toBe(false);
  });

  it("matches model aliases", () => {
    expect(
      environmentSupportsModelSelection({
        providers: [provider({ instanceId: "codex", models: [model("gpt-5", ["latest"])] })],
        instanceId: codex,
        driver: codexDriver,
        model: "latest",
      }),
    ).toBe(true);
  });

  it("falls back to provider-level matching without a model", () => {
    expect(
      environmentSupportsModelSelection({
        providers: [provider({ instanceId: "codex" })],
        instanceId: codex,
        driver: codexDriver,
        model: null,
      }),
    ).toBe(true);
  });

  it("matches any instance of the driver without an instance", () => {
    expect(
      environmentSupportsModelSelection({
        providers: [provider({ instanceId: "codex_personal", driver: "codex" })],
        instanceId: null,
        driver: codexDriver,
        model: null,
      }),
    ).toBe(true);
  });
});

describe("deriveAutoBalanceProviderStatuses", () => {
  it("returns an empty catalogue without environments", () => {
    expect(
      deriveAutoBalanceProviderStatuses({ environments: [], preferredEnvironmentId: null }),
    ).toEqual([]);
  });

  it("unions instances that exist on only one machine", () => {
    const merged = deriveAutoBalanceProviderStatuses({
      environments: [
        { environmentId: primaryEnv, providers: [provider({ instanceId: "codex" })] },
        {
          environmentId: secondaryEnv,
          providers: [
            provider({ instanceId: "codex" }),
            provider({ instanceId: "groq", driver: "groq" }),
          ],
        },
      ],
      preferredEnvironmentId: primaryEnv,
    });

    expect(merged.map((snapshot) => snapshot.instanceId as string)).toEqual(["codex", "groq"]);
  });

  it("keeps primary-first instance order", () => {
    const merged = deriveAutoBalanceProviderStatuses({
      environments: [
        {
          environmentId: primaryEnv,
          providers: [provider({ instanceId: "codex" }), provider({ instanceId: "claude" })],
        },
        { environmentId: secondaryEnv, providers: [provider({ instanceId: "aardvark" })] },
      ],
      preferredEnvironmentId: null,
    });

    expect(merged.map((snapshot) => snapshot.instanceId as string)).toEqual([
      "codex",
      "claude",
      "aardvark",
    ]);
  });

  it("unions models by slug without duplicates", () => {
    const merged = deriveAutoBalanceProviderStatuses({
      environments: [
        {
          environmentId: primaryEnv,
          providers: [provider({ instanceId: "codex", models: [model("gpt-5"), model("o4")] })],
        },
        {
          environmentId: secondaryEnv,
          providers: [provider({ instanceId: "codex", models: [model("o4"), model("gpt-6")] })],
        },
      ],
      preferredEnvironmentId: primaryEnv,
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.models.map((candidate) => candidate.slug)).toEqual(["gpt-5", "o4", "gpt-6"]);
  });

  it("prefers the preferred environment's snapshot when routable", () => {
    const merged = deriveAutoBalanceProviderStatuses({
      environments: [
        {
          environmentId: primaryEnv,
          providers: [
            {
              ...provider({ instanceId: "codex", models: [model("gpt-5")] }),
              message: "primary",
            },
          ],
        },
        {
          environmentId: secondaryEnv,
          providers: [
            {
              ...provider({ instanceId: "codex", models: [model("gpt-5")] }),
              message: "secondary",
            },
          ],
        },
      ],
      preferredEnvironmentId: secondaryEnv,
    });

    expect(merged[0]?.message).toBe("secondary");
  });

  it("falls back to a ready snapshot elsewhere when the preferred one is not ready", () => {
    const merged = deriveAutoBalanceProviderStatuses({
      environments: [
        {
          environmentId: primaryEnv,
          providers: [provider({ instanceId: "codex", status: "warning" })],
        },
        { environmentId: secondaryEnv, providers: [provider({ instanceId: "codex" })] },
      ],
      preferredEnvironmentId: primaryEnv,
    });

    // The entry must stay picker-ready because one machine serves it.
    expect(merged[0]?.status).toBe("ready");
  });
});

describe("shouldResetAutoBalanceRouting", () => {
  const codex = ProviderInstanceId.make("codex");
  const groq = ProviderInstanceId.make("groq");

  it("never resets outside automatic mode or without a pin", () => {
    expect(
      shouldResetAutoBalanceRouting({
        automaticEnvironment: false,
        pinnedEnvironmentId: secondaryEnv,
        previousInstanceId: codex,
        previousModel: "gpt-5",
        nextInstanceId: groq,
        nextModel: "moonshot",
      }),
    ).toBe(false);
    expect(
      shouldResetAutoBalanceRouting({
        automaticEnvironment: true,
        pinnedEnvironmentId: null,
        previousInstanceId: codex,
        previousModel: "gpt-5",
        nextInstanceId: groq,
        nextModel: "moonshot",
      }),
    ).toBe(false);
  });

  it("keeps the pin when the identical selection is re-picked", () => {
    expect(
      shouldResetAutoBalanceRouting({
        automaticEnvironment: true,
        pinnedEnvironmentId: secondaryEnv,
        previousInstanceId: codex,
        previousModel: "gpt-5",
        nextInstanceId: codex,
        nextModel: "gpt-5",
      }),
    ).toBe(false);
  });

  it("resets when the instance or the model changes", () => {
    const base = {
      automaticEnvironment: true,
      pinnedEnvironmentId: secondaryEnv,
      previousInstanceId: codex,
      previousModel: "gpt-5",
    } as const;
    expect(
      shouldResetAutoBalanceRouting({ ...base, nextInstanceId: groq, nextModel: "moonshot" }),
    ).toBe(true);
    expect(
      shouldResetAutoBalanceRouting({ ...base, nextInstanceId: codex, nextModel: "gpt-6" }),
    ).toBe(true);
  });

  it("resets when there was no previous selection", () => {
    expect(
      shouldResetAutoBalanceRouting({
        automaticEnvironment: true,
        pinnedEnvironmentId: secondaryEnv,
        previousInstanceId: null,
        previousModel: null,
        nextInstanceId: codex,
        nextModel: "gpt-5",
      }),
    ).toBe(true);
  });
});
