import {
  applyEnvRegionOverride,
  parseAwsSsoLoginOutput,
} from "@/AWS/AuthProvider.ts";
import { loadConfigProvider } from "@/Util/ConfigProvider.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

const withEnv = (env: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

// Simulates credentials resolved from an SSO profile whose ~/.aws/config
// region differs from the region the user explicitly set in the environment.
const profileCreds = { accountId: "123456789012", region: "us-west-2" };

describe("parseAwsSsoLoginOutput", () => {
  it("reads browser authorization JSON", () => {
    expect(
      parseAwsSsoLoginOutput(
        JSON.stringify({
          authorizationUrl: "https://oidc.example.com/authorize?state=abc",
        }),
      ),
    ).toEqual({
      url: "https://oidc.example.com/authorize?state=abc",
      code: undefined,
    });
  });

  it("reads the text AWS emits despite --output json", () => {
    expect(
      parseAwsSsoLoginOutput(`Browser will not be automatically opened.
Please visit the following URL:

https://example.awsapps.com/start/#/device

Then enter the code:

CRKF-LVXR`),
    ).toEqual({
      url: "https://example.awsapps.com/start/#/device",
      code: "CRKF-LVXR",
    });
  });
});

describe("applyEnvRegionOverride", () => {
  it.effect("AWS_REGION overrides the profile region", () =>
    Effect.gen(function* () {
      const creds = yield* applyEnvRegionOverride(profileCreds);
      expect(creds.region).toBe("us-east-2");
      expect(creds.accountId).toBe("123456789012");
    }).pipe(withEnv({ AWS_REGION: "us-east-2" })),
  );

  // AWS_DEFAULT_REGION is a default, not an override — the profile's region
  // is explicit configuration and must win over it.
  it.effect("AWS_DEFAULT_REGION does NOT override the profile region", () =>
    Effect.gen(function* () {
      const creds = yield* applyEnvRegionOverride(profileCreds);
      expect(creds.region).toBe("us-west-2");
    }).pipe(withEnv({ AWS_DEFAULT_REGION: "eu-west-1" })),
  );

  it.effect("falls back to the profile region when no env is set", () =>
    Effect.gen(function* () {
      const creds = yield* applyEnvRegionOverride(profileCreds);
      expect(creds.region).toBe("us-west-2");
    }).pipe(withEnv({})),
  );

  it.effect(
    "process environment overrides the default dotenv region",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fs.makeTempDirectoryScoped({
            prefix: "alchemy-config-provider-",
          });
          yield* fs.writeFileString(
            path.join(tempDir, ".env"),
            "AWS_REGION=ap-south-1\n",
          );

          const originalCwd = process.cwd();
          const originalRegion = process.env.AWS_REGION;
          yield* Effect.gen(function* () {
            yield* Effect.sync(() => {
              process.chdir(tempDir);
              process.env.AWS_REGION = "us-east-1";
            });

            const configProvider = yield* loadConfigProvider(Option.none());
            const creds = yield* applyEnvRegionOverride({
              accountId: "654654387918",
              region: "us-west-2",
            }).pipe(Effect.provide(ConfigProvider.layer(configProvider)));
            expect(creds.region).toBe("us-east-1");
            expect(creds.accountId).toBe("654654387918");
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                process.chdir(originalCwd);
                if (originalRegion === undefined) {
                  delete process.env.AWS_REGION;
                } else {
                  process.env.AWS_REGION = originalRegion;
                }
              }),
            ),
          );
        }),
      ).pipe(Effect.provide(PlatformServices)),
    { exclusive: true },
  );
});
