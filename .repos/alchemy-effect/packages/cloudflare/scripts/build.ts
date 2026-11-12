import { build, typescript } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  // Bootstrap modules are source inputs to the deployment bundler.
  exports: { generate: true, worker: true, sourceOnly: ["./Bootstrap/*"] },
  steps: [typescript("-b")],
});
