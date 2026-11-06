import { build, copy, exec, typescript, named } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  thirdPartyLicenses: true,
  stamp: "dist",
  steps: [
    // tsdown resolves distilled from its compiled `lib/`.
    named(
      "build distilled (aws, cloudflare)",
      typescript(
        "-b",
        "../../submodules/distilled/packages/aws/tsconfig.json",
        "../../submodules/distilled/packages/cloudflare/tsconfig.json",
      ),
    ),
    exec("tsdown"),
    // tsdown cleans dist/, deleting the declarations while their
    // tsbuildinfo in .cache/ still reports them up to date.
    named("emit declarations", typescript("-b", "--force", "tsconfig.json")),
    copy("src/nextjs/runner.mjs", "dist/nextjs/runner.mjs"),
  ],
});
