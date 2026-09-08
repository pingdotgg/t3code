import {
  isId,
  resolveZoneId,
  zoneNameCandidates,
} from "@/Cloudflare/Zone/lookup.ts";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

describe("Cloudflare zone lookup", () => {
  const withoutCredentials = <A, E>(
    effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) =>
    effect.pipe(
      Effect.provideService(
        Credentials,
        Effect.die("explicit zone IDs must not resolve credentials"),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die("explicit zone IDs must not list zones"),
        ),
      ),
      Effect.runSync,
    );

  test("zoneNameCandidates walks hostname labels longest-first", () => {
    expect(zoneNameCandidates("app.example.com")).toEqual([
      "app.example.com",
      "example.com",
    ]);
    expect(zoneNameCandidates("a.b.c.example.com")).toEqual([
      "a.b.c.example.com",
      "b.c.example.com",
      "c.example.com",
      "example.com",
    ]);
    expect(zoneNameCandidates("example.com")).toEqual(["example.com"]);
  });

  test("resolveZoneId returns an explicit zone id without listing zones", () => {
    const zoneId = "0123456789abcdef0123456789abcdef";
    expect(isId(zoneId)).toBe(true);
    expect(
      withoutCredentials(
        resolveZoneId({
          accountId: "account",
          zone: zoneId,
          hostname: "app.example.com",
        }),
      ),
    ).toEqual(zoneId);
    expect(
      withoutCredentials(
        resolveZoneId({
          accountId: "account",
          zone: { zoneId, name: "example.com" },
          hostname: "app.example.com",
        }),
      ),
    ).toEqual(zoneId);
  });
});
