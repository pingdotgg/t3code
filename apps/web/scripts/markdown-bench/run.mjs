import { register } from "node:module";
register("./resolve.mjs", import.meta.url);
await import({ equivalence: "./equivalence.ts", oracle: "./oracle.ts", probe: "./probe.ts" }[process.argv[2]] ?? "./bench.ts");
