// @ts-check
import { defineConfig } from "astro/config";

// NO `adapter` here: the AWS deploy target injects its Lambda adapter.
// `output` is owned by the composite's inline config (server by default;
// `astro: { output: "static" }` opts into a fully prerendered site).
export default defineConfig({});
