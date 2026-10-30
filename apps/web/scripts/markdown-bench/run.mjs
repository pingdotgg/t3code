import { register } from "node:module";
register("./resolve.mjs", import.meta.url);
await import({ equivalence: "./equivalence.ts", oracle: "./oracle.ts", probe: "./probe.ts", "oracle-hast": "./oracle-hast.ts", bail: "./bail-stats.ts", "prof-direct": "./prof-direct.ts", "probe-hast": "./probe-hast.ts" }[process.argv[2]] ?? "./bench.ts");
