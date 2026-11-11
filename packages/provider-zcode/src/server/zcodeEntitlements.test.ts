// @effect-diagnostics nodeBuiltinImport:off -- tests craft the CLI's own AES-GCM store values with node crypto
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  decryptZcodeCredential,
  resolveZcodeCredentialSecret,
  zcodeEntitledModels,
} from "./zcodeEntitlements.ts";

/** Produces store values the CLI's fallback cipher would hold, keyed the same way. */
const encryptZcodeCredential = (value: string, secret: string): string => {
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv(
    "aes-256-gcm",
    NodeCrypto.createHash("sha256").update(secret).digest(),
    iv,
  );
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
};

const catalog = {
  config: {
    providerConfigRules: {
      providerRules: [
        {
          providerId: "account:zai-individual-coding-plan",
          config: {
            access: { type: "zhipu-account", mode: "individual-coding-plan", accountType: "zai" },
            builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash"],
          },
        },
        {
          providerId: "account:zai-team-coding-plan",
          config: {
            access: { type: "zhipu-account", mode: "team-coding-plan", accountType: "zai" },
            builtinModelIds: ["GLM-5.3"],
          },
        },
        {
          providerId: "zai-api",
          config: { access: { type: "api-key" }, builtinModelIds: ["GLM-5.3"] },
        },
      ],
    },
    modelConfigRules: {
      modelRules: [
        {
          modelMatch: "^GLM-5\\.3$",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "high", "max"] } } },
        },
        {
          modelMatch: "^GLM-5\\.3-Flash$",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
        },
      ],
    },
  },
};

describe("resolveZcodeCredentialSecret", () => {
  it("prefers ZCODE_CREDENTIAL_SECRET and trims it", () => {
    assert.equal(
      resolveZcodeCredentialSecret({ ZCODE_CREDENTIAL_SECRET: " custom-secret " }, "linux"),
      "custom-secret",
    );
    const blankOverride = resolveZcodeCredentialSecret(
      { ZCODE_CREDENTIAL_SECRET: "   ", HOME: "/home/dev" },
      "linux",
    );
    assert.match(blankOverride, /^zcode-credential-fallback:linux:\/home\/dev:/);
  });

  it("derives the CLI's machine-bound fallback with the HOME from the environment", () => {
    // Username comes from os.userInfo() where resolvable (env names never win); on runtimes
    // where it throws, the env fallback speaks. Only the stable parts are asserted here.
    const secret = resolveZcodeCredentialSecret(
      { USER: "someoneElse", HOME: "/home/dev" },
      "darwin",
    );
    assert.match(secret, /^zcode-credential-fallback:darwin:\/home\/dev:/);
    assert.match(resolveZcodeCredentialSecret({}, "linux"), /^zcode-credential-fallback:linux:/);
  });
});

describe("decryptZcodeCredential", () => {
  it("round-trips the CLI's encrypted store values", () => {
    const secret = "zcode-credential-fallback:linux:/home/dev:jame";
    for (const plaintext of ["oauth-login-token", "值-with-unicode 🔐", ""]) {
      assert.equal(
        decryptZcodeCredential(encryptZcodeCredential(plaintext, secret), secret),
        plaintext,
      );
    }
  });

  it("passes plain store values through and rejects malformed ciphertext", () => {
    assert.equal(decryptZcodeCredential("plain-token", "s"), "plain-token");
    assert.throws(() => decryptZcodeCredential("enc:v1:not-a-cipher", "s"));
    assert.throws(() => decryptZcodeCredential("enc:v1:only.two", "s"));
  });
});

describe("zcodeEntitledModels", () => {
  const harness = (input: {
    readonly customModels?: unknown;
    readonly setting?: unknown;
    readonly loginToken?: string;
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-entitlements-test-" });
        const platform = yield* HostProcess.Platform;
        const environment = { ZCODE_DATA_BASE_DIR: root, HOME: "/home/dev", USER: "dev" };
        yield* fs.makeDirectory(`${root}/.zcode/v2`, { recursive: true });
        if (input.setting !== undefined) {
          yield* fs.writeFileString(
            `${root}/.zcode/v2/setting.json`,
            JSON.stringify(input.setting),
          );
        }
        if (input.loginToken !== undefined) {
          yield* fs.writeFileString(
            `${root}/.zcode/v2/credentials.json`,
            JSON.stringify({
              "oauth:zai:access_token": encryptZcodeCredential(
                input.loginToken,
                resolveZcodeCredentialSecret(environment, platform),
              ),
            }),
          );
        }
        return yield* zcodeEntitledModels(fs, {
          builtinPath: `${root}/zcode-builtin.json`,
          builtinCatalog: input.customModels ?? catalog,
          environment,
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer));

  it.effect("enumerates selected individual-coding-plan models with catalog reasoning levels", () =>
    Effect.gen(function* () {
      const models = yield* harness({
        setting: {
          providerFamilyConnectionSelections: { zai: { kind: "individual-coding-plan" } },
        },
        loginToken: "zai-login-token",
      });
      assert.deepEqual(models, [
        {
          providerId: "account:zai-individual-coding-plan",
          modelId: "GLM-5.3",
          reasoningLevels: ["low", "high", "max"],
        },
        {
          providerId: "account:zai-individual-coding-plan",
          modelId: "GLM-5.3-Flash",
          reasoningLevels: ["low", "high"],
        },
      ]);
    }),
  );

  it.effect("drops a family switched to apiKey mode even with a login token", () =>
    Effect.gen(function* () {
      const models = yield* harness({
        setting: {
          providerFamilyConnectionSelections: { zai: { kind: "individual-coding-plan" } },
          modelProviderFamilyModes: { zai: "apiKey" },
        },
        loginToken: "zai-login-token",
      });
      assert.deepEqual(models, []);
    }),
  );

  it.effect("skips catalogs without zhipu-account rules", () =>
    Effect.gen(function* () {
      const models = yield* harness({
        customModels: { config: { providerConfigRules: { providerRules: [] } } },
      });
      assert.deepEqual(models, []);
    }),
  );
});
