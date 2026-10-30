import { register } from "node:module";
register("./resolve.mjs", import.meta.url);
await import("./bench.ts");
