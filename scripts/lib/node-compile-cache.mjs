import * as NodeModule from "node:module";

// Preload before the dev runner's imports so its CLI graph is cached too.
// Node honors NODE_COMPILE_CACHE and NODE_DISABLE_COMPILE_CACHE and falls
// back to its per-user temporary cache when no directory was configured.
NodeModule.enableCompileCache();
