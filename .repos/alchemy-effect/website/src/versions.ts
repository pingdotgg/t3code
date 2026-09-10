import alchemyPkg from "../../packages/alchemy/package.json" with { type: "json" };

export const alchemyVersion = alchemyPkg.version;
// effect's npm dist-tag for the 4.0 release candidates (effect@rc,
// @effect/platform-bun@rc, @effect/platform-node@rc).
export const effectVersion = "rc";
