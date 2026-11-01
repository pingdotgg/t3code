import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// Intentionally duplicated from alchemy's Util/PlatformServices.ts: this
// package must not depend on "alchemy", and the message names this package.
const importPlatformPeer = <A>(
  peerDependency: "@effect/platform-bun" | "@effect/platform-node",
  load: () => Promise<A>,
): Promise<A> =>
  load().catch(() => {
    console.error(
      [
        `"@alchemy.run/cloudflare-frameworks" could not load its peer dependency "${peerDependency}".`,
        `Install a compatible version of "${peerDependency}" alongside "@alchemy.run/cloudflare-frameworks".`,
      ].join("\n"),
    );
    process.exit(1);
  });

const BunServices = {
  layer: Layer.unwrap(
    Effect.promise(() =>
      importPlatformPeer(
        "@effect/platform-bun",
        () => import("@effect/platform-bun/BunServices"),
      ).then((module) => module.layer),
    ),
  ),
};

const NodeServices = {
  layer: Layer.unwrap(
    Effect.promise(() =>
      importPlatformPeer(
        "@effect/platform-node",
        () => import("@effect/platform-node/NodeServices"),
      ).then((module) => module.layer),
    ),
  ),
};

export const PlatformServices =
  typeof Bun === "undefined" ? NodeServices.layer : BunServices.layer;
