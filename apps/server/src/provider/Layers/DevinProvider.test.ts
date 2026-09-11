import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { checkDevinProviderStatus } from "./DevinProvider.ts";
import { makeDevinCli as makeHarness, devinTestLayer as layer } from "../testUtils/devinCli.ts";

it.effect("reports signed-out status without creating an ACP session", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const snapshot = yield* checkDevinProviderStatus(h.settings, h.environment);
    expect(snapshot.auth.status).toBe("unauthenticated");
    const fs = yield* FileSystem.FileSystem;
    expect(yield* fs.exists(h.requestLog)).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect("uses the supplied environment to check sign-in and discover models before a chat", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const environment = {
      ...h.environment,
      T3_DEVIN_AUTH_STATUS: "Logged in (via Devin).",
    };
    const snapshot = yield* checkDevinProviderStatus(h.settings, environment);
    expect(snapshot.auth.status).toBe("authenticated");
    expect(snapshot.status).toBe("ready");
    expect(snapshot.models.map((model) => [model.slug, model.name])).toEqual([
      ["devin-test", "Devin Test"],
    ]);
    const fs = yield* FileSystem.FileSystem;
    expect(yield* fs.exists(h.requestLog)).toBe(false);
    const signedOut = yield* checkDevinProviderStatus(h.settings, {
      ...environment,
      T3_DEVIN_AUTH_STATUS: "Not logged in.",
    });
    expect(signedOut.auth.status).toBe("unauthenticated");
    expect(signedOut.models).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps authenticated status and reports catalog failures", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const snapshot = yield* checkDevinProviderStatus(h.settings, {
      ...h.environment,
      T3_DEVIN_AUTH_STATUS: "Logged in (via Devin).",
      T3_DEVIN_FAIL_MODELS: "1",
    });
    expect(snapshot.auth.status).toBe("authenticated");
    expect(snapshot.version).toBe("3000.5.20");
    expect(snapshot.status).toBe("warning");
    expect(snapshot.message).toContain("Could not load Devin models");
  }).pipe(Effect.provide(layer)),
);
