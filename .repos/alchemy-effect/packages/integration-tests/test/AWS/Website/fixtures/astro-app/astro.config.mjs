// @ts-check
import { defineConfig } from "astro/config";

// NO `adapter` here: the AWS deploy target injects its Lambda adapter.
// No `output` either: the composite deploys server output by default
// (`output: "static"` here or `astro: { output: "static" }` opts into a
// fully prerendered site).
export default defineConfig({});
