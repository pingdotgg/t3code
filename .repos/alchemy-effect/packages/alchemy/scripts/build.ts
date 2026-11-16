import { build, typescript } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  // The shared bootstrap helpers every provider's `Bootstrap` imports stay source.
  exports: {
    sourceOnly: ["./Runtime/Bootstrap", "./Runtime/ManagedHttpShutdown"],
  },
  thirdPartyLicenses: true,
  readme: true,
  steps: [typescript("-b")],
});
