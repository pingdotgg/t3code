import { describe, expect, it } from "@effect/vitest";
import { MuseSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import type { MuseSdkHost } from "./sdk.ts";
import {
  museModelCapabilities,
  probeMuseHost,
  resolveMuseReasoningEffort,
} from "./modelCatalog.ts";

const settings = Schema.decodeSync(MuseSettings)({});
const host = (
  catalog: Record<string, unknown>,
  account?: Record<string, unknown>,
): MuseSdkHost => ({
  connection: {
    request: async (method: string) => (method === "account/read" && account ? account : catalog),
    command: async () => ({}),
    mintCommandId: () => "test",
    onNotification: () => {},
    onServerRequest: () => {},
    onProtocolError: () => {},
    closed: new Promise<void>(() => {}),
  },
  initializeResult: { grantedCapabilities: [] },
  exited: new Promise(() => {}),
  close: async () => {},
});

const row = (modelId: string, extra: Record<string, unknown> = {}) => ({
  modelId,
  displayLabel: modelId,
  providerId: "meta",
  profileId: "tbh",
  isDefault: false,
  contextLimit: 1_000_000,
  ...extra,
});

describe("Muse model catalog", () => {
  it.effect("uses the labels, efforts and defaults that model/list sends", () =>
    Effect.gen(function* () {
      const { models, account } = yield* probeMuseHost(settings, {}, undefined, async () =>
        host({
          providerId: "meta",
          profileId: "tbh",
          source: "providerCatalog",
          models: [
            row("restful-walrus", {
              displayLabel: " Restful Walrus ",
              isDefault: true,
              variants: ["minimal", "low", "high", "future-tier"],
              reasoningEffortVariants: [{ tier: "low", description: "Quick" }],
              defaultReasoningEffort: "high",
            }),
            row("older-host"),
            row("unknown-efforts", { variants: "unknown" }),
            row("foreign", { providerId: "another" }),
          ],
        }),
      ).pipe(Effect.scoped);
      expect(models.map(({ slug, name, isDefault }) => [slug, name, isDefault])).toEqual([
        ["restful-walrus", "Restful Walrus", true],
        ["older-host", "older-host", false],
        ["unknown-efforts", "unknown-efforts", false],
      ]);
      expect(models[0]?.capabilities?.optionDescriptors).toEqual([
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          currentValue: "high",
          options: [
            { id: "minimal", label: "Minimal" },
            { id: "low", label: "Low", description: "Quick" },
            { id: "high", label: "High", isDefault: true },
          ],
        },
      ]);
      // Older hosts and "unknown" fall back to Muse's documented tiers.
      expect(models[1]?.capabilities).toEqual(museModelCapabilities());
      expect(models[2]?.capabilities).toEqual(museModelCapabilities());
      // A host that does not answer account/read in the expected shape leaves the account unknown.
      expect(account).toBeUndefined();
    }),
  );

  it.effect("reads the signed-in account from the experimental account/read", () =>
    Effect.gen(function* () {
      const { account } = yield* probeMuseHost(settings, {}, undefined, async () =>
        host(
          { providerId: "meta", models: [row("muse-spark-1.3", { isDefault: true })] },
          {
            state: "accountLogin",
            label: "person@example.com",
            avatarUrl: "https://example.com/a.png",
            credentialRequired: true,
          },
        ),
      ).pipe(Effect.scoped);
      expect(account).toEqual({
        state: "accountLogin",
        label: "person@example.com",
        credentialRequired: true,
      });
    }),
  );

  it.effect("keeps the models when account/read never answers", () =>
    Effect.gen(function* () {
      const base = host({
        providerId: "meta",
        models: [row("muse-spark-1.3", { isDefault: true })],
      });
      let askedForAccount = () => {};
      const accountRequested = new Promise<void>((resolve) => {
        askedForAccount = resolve;
      });
      const probing = yield* probeMuseHost(settings, {}, undefined, async () => ({
        ...base,
        connection: {
          ...base.connection,
          request: (method: string) => {
            if (method !== "account/read") return base.connection.request(method);
            askedForAccount();
            return new Promise<never>(() => {});
          },
        },
      })).pipe(Effect.scoped, Effect.forkChild);
      yield* Effect.promise(() => accountRequested);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("2 seconds");
      // Bounded in real time, so a probe that waits on account/read fails here instead of hanging.
      const { models, account } = yield* TestClock.withLive(
        Fiber.join(probing).pipe(Effect.timeout("1 second")),
      );
      expect(models.map(({ slug }) => slug)).toEqual(["muse-spark-1.3"]);
      expect(account).toBeUndefined();
    }),
  );

  it("normalizes saved and implicit efforts against the selected model before dispatch", () => {
    const fallback = museModelCapabilities();
    expect(resolveMuseReasoningEffort(fallback, undefined)).toBe("high");
    expect(resolveMuseReasoningEffort(fallback, "max")).toBe("max");
    expect(resolveMuseReasoningEffort(fallback, "ultra")).toBe("high");
    const restricted = museModelCapabilities({ variants: ["xhigh"] });
    expect(resolveMuseReasoningEffort(restricted, undefined)).toBe("xhigh");
    expect(resolveMuseReasoningEffort(restricted, "low")).toBe("xhigh");
    expect(
      resolveMuseReasoningEffort(museModelCapabilities({ variants: [] }), "max"),
    ).toBeUndefined();
    expect(resolveMuseReasoningEffort(undefined, "max")).toBe("max");
  });
});
