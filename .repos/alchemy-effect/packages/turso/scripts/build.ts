import { build, typescript } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  exports: { generate: true, worker: true },
  steps: [typescript("-b")],
});
