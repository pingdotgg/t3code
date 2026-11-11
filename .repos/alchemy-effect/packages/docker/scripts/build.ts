import { build, typescript } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  // The bootstrap is a source input to the deployment bundler.
  exports: { generate: true, sourceOnly: ["./Bootstrap"] },
  steps: [typescript("-b")],
});
