import { build, typescript } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  exports: { worker: true },
  steps: [typescript("-b")],
});
