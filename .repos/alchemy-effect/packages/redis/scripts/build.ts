import { build, typescript } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  exports: { generate: true },
  steps: [typescript("-b")],
});
