import { build, typescript } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  steps: [typescript("-b")],
});
