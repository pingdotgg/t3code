import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as SecureStore from "expo-secure-store";
import { vi } from "vite-plus/test";

const secureStore = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn((key: string) => Promise.resolve(secureStore.get(key) ?? null)),
  setItemAsync: vi.fn((key: string, value: string) => {
    secureStore.set(key, value);
    return Promise.resolve();
  }),
  deleteItemAsync: vi.fn((key: string) => {
    secureStore.delete(key);
    return Promise.resolve();
  }),
}));

import {
  ManagedRelayTokenStoreError,
  managedRelayAccessTokenStore,
} from "./managedRelayTokenStore";

it.effect("round-trips and clears persisted managed relay access tokens", () =>
  Effect.gen(function* () {
    secureStore.clear();
    const entries = [
      {
        accountId: "user-1",
        clientId: "t3-mobile",
        relayUrl: "https://relay.example.test",
        thumbprint: "thumbprint",
        scopes: ["environment:connect"],
        accessToken: "access-token",
        expiresAtMillis: 1_800_000,
      },
    ] as const;

    yield* managedRelayAccessTokenStore.save(entries);
    expect(yield* managedRelayAccessTokenStore.load).toEqual(entries);

    yield* managedRelayAccessTokenStore.clear;
    expect(yield* managedRelayAccessTokenStore.load).toEqual([]);
  }),
);

it.effect("falls back to an empty cache when persisted data is invalid", () =>
  Effect.gen(function* () {
    secureStore.clear();
    secureStore.set("t3code.cloud.relay-access-tokens", "not-json");

    expect(yield* managedRelayAccessTokenStore.load).toEqual([]);
  }),
);

it.effect("logs structured storage failures before falling back to an empty cache", () => {
  const messages: Array<unknown> = [];
  const logger = Logger.make(({ message }) => {
    messages.push(message);
  });
  const cause = new Error("secure store unavailable");
  vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(cause);

  return Effect.gen(function* () {
    expect(yield* managedRelayAccessTokenStore.load).toEqual([]);

    const message = messages.find(
      (candidate) =>
        Array.isArray(candidate) && candidate[0] === "Managed relay token store operation failed.",
    );
    expect(message).toBeDefined();
    const context = (message as ReadonlyArray<unknown>)[1] as {
      readonly cause: ManagedRelayTokenStoreError;
    };
    expect(context.cause).toBeInstanceOf(ManagedRelayTokenStoreError);
    expect(context.cause).toMatchObject({
      operation: "read",
      storageKey: "t3code.cloud.relay-access-tokens",
      cause,
    });
    expect(context.cause.message).not.toContain(cause.message);
  }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
});
