import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";

export const applications = (maxInstances = 2, name?: string) =>
  Effect.gen(function* () {
    const owned = yield* Cloudflare.Container("CachedIdentity", {
      name,
      image: "mendhak/http-https-echo:41",
      maxInstances,
    }).Application;
    const other = yield* Cloudflare.Container("OtherIdentity", {
      image: "mendhak/http-https-echo:41",
      maxInstances: 3,
    }).Application;
    return { owned, other };
  });
