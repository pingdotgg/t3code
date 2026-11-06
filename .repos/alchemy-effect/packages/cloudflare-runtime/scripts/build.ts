import { build, exec, typescript, named } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  thirdPartyLicenses: true,
  stamp: "dist",
  steps: [
    // tsdown resolves distilled from its compiled `lib/`.
    named(
      "build distilled (cloudflare)",
      typescript("-b", "../../submodules/distilled/packages/cloudflare/tsconfig.json"),
    ),
    exec("tsdown"),
  ],
});
