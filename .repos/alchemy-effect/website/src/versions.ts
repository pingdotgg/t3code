import rootPkg from "../../package.json" with { type: "json" };
import alchemyPkg from "../../packages/alchemy/package.json" with { type: "json" };

export const alchemyVersion = alchemyPkg.version;
export const effectVersion = rootPkg.workspaces.catalog.effect;
