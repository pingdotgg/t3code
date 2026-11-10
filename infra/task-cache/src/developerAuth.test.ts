import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";

import { developerIdentity } from "./developerAuth.ts";

const token = "fixture-token-012345678901234567890123456789";
const keys = JSON.stringify({
  julius: "210eb3d2c67a7207923e1999751300a87a2dd22839b258b80c3d805a6fe64984",
});
const request = (credentials: string) =>
  new Request("https://cache.example/projects/t3code/store", {
    headers: { authorization: `Basic ${btoa(credentials)}` },
  });

it.effect(
  "accepts the registered developer and rejects wrong, revoked, or malformed credentials",
  () =>
    Effect.gen(function* () {
      expect(yield* developerIdentity(request(`julius:${token}`), keys)).toBe("julius");
      expect(yield* developerIdentity(request(`theo:${token}`), keys)).toBeNull();
      expect(yield* developerIdentity(request(`julius:${token}wrong`), keys)).toBeNull();
      expect(yield* developerIdentity(request(`julius:${token}`), "{}")).toBeNull();
      expect(yield* developerIdentity(request(`julius:${token}`), undefined)).toBeNull();
      expect(yield* developerIdentity(request("malformed"), keys)).toBeNull();
      expect(yield* developerIdentity(request(`constructor:${token}`), keys)).toBeNull();
    }),
);

it.effect("leaves anonymous reads and GitHub OIDC authorization to the upstream Worker", () =>
  Effect.gen(function* () {
    expect(yield* developerIdentity(new Request("https://cache.example"), keys)).toBeUndefined();
    const oidc = new Request("https://cache.example", {
      headers: { authorization: "Bearer github-oidc-token" },
    });
    expect(yield* developerIdentity(oidc, keys)).toBeUndefined();
  }),
);
