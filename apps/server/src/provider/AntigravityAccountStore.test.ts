import * as NodeServices from "@effect/platform-node/NodeServices";
import { AntigravityAccountId, AntigravitySettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import {
  listAntigravityAccounts,
  readAntigravityAccountFingerprint,
  removeAntigravityAccount,
  resolveAntigravityGeminiHomePath,
  saveAntigravityAccount,
  switchAntigravityAccount,
} from "./AntigravityAccountStore.ts";

const makeTempDir = Effect.fn("AntigravityAccountStore.test.makeTempDir")(function* (
  prefix: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTextFile = Effect.fn("AntigravityAccountStore.test.writeTextFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

const seedGeminiCredentials = Effect.fn("AntigravityAccountStore.test.seedGeminiCredentials")(
  function* (geminiHome: string, fingerprintSuffix: string) {
    const path = yield* Path.Path;
    yield* writeTextFile(
      path.join(geminiHome, "antigravity/installation_id"),
      `antigravity-${fingerprintSuffix}`,
    );
    yield* writeTextFile(
      path.join(geminiHome, "antigravity-cli/installation_id"),
      `cli-${fingerprintSuffix}`,
    );
    yield* writeTextFile(
      path.join(geminiHome, "antigravity/implicit/token.pb"),
      `token-${fingerprintSuffix}`,
    );
  },
);

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

const TestLayer = Layer.mergeAll(
  NodeServices.layer,
  Layer.fresh(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-antigravity-account-store-",
    }).pipe(Layer.provide(NodeServices.layer)),
  ),
);

it.layer(NodeServices.layer)("AntigravityAccountStore", (it) => {
  it.effect("reads a fingerprint from installation ids", () =>
    Effect.gen(function* () {
      const geminiHome = yield* makeTempDir("t3code-gemini-home-");
      yield* seedGeminiCredentials(geminiHome, "alpha");
      const fingerprint = yield* readAntigravityAccountFingerprint(geminiHome);
      expect(fingerprint).toBe("antigravity-alpha:cli-alpha");
    }),
  );

  it.effect("saves, switches, and removes Antigravity account snapshots", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverConfig = yield* ServerConfig;
      const geminiHome = path.join(serverConfig.stateDir, "gemini-home");
      const settings = decodeAntigravitySettings({ geminiHomePath: geminiHome, enabled: true });

      yield* seedGeminiCredentials(geminiHome, "personal");
      const saved = yield* saveAntigravityAccount({
        settings,
        label: "Personal",
      });

      expect(saved.accounts).toHaveLength(1);
      expect(saved.accounts[0]?.label).toBe("Personal");
      expect(saved.activeAccountId).toBe(saved.accounts[0]?.id);

      for (const relativePath of [
        "antigravity/installation_id",
        "antigravity-cli/installation_id",
        "antigravity/implicit/token.pb",
      ] as const) {
        const snapshotPath = path.join(
          serverConfig.stateDir,
          "antigravity-accounts",
          saved.accounts[0]!.id,
          "snapshot",
          relativePath,
        );
        expect(yield* fileSystem.exists(snapshotPath)).toBe(true);
      }

      yield* seedGeminiCredentials(geminiHome, "work");
      const workSaved = yield* saveAntigravityAccount({
        settings,
        label: "Work",
      });
      expect(workSaved.accounts).toHaveLength(2);

      const workAccountId = workSaved.accounts.find((account) => account.label === "Work")?.id;
      expect(workAccountId).toBeDefined();

      yield* switchAntigravityAccount({
        settings,
        accountId: workAccountId!,
      });

      const personalFingerprint = yield* readAntigravityAccountFingerprint(geminiHome);
      expect(personalFingerprint).toBe("antigravity-work:cli-work");

      const personalAccountId = saved.accounts[0]!.id;
      yield* switchAntigravityAccount({
        settings,
        accountId: personalAccountId,
      });

      const restoredFingerprint = yield* readAntigravityAccountFingerprint(geminiHome);
      expect(restoredFingerprint).toBe("antigravity-personal:cli-personal");

      const listed = yield* listAntigravityAccounts(settings);
      expect(listed.registry.accounts).toHaveLength(2);
      expect(listed.detection.matchedAccountId).toBe(personalAccountId);

      const removed = yield* removeAntigravityAccount({
        accountId: AntigravityAccountId.make(personalAccountId),
      });
      expect(removed.accounts).toHaveLength(1);
      expect(resolveAntigravityGeminiHomePath(settings)).toBe(geminiHome);
    }).pipe(Effect.provide(TestLayer)),
  );
});
