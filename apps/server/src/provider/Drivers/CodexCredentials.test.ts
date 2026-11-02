import * as Crypto from "effect/Crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CodexSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  resolveCodexCredentialFingerprint,
  resolveEffectiveCodexAuthJsonPath,
} from "./CodexCredentials.ts";

const decodeCodexSettingsValue = Schema.decodeSync(CodexSettings);

const decodeCodexSettings = (input: {
  readonly enabled?: boolean;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly customModels?: readonly string[];
  readonly binaryPath?: string;
}): CodexSettings => decodeCodexSettingsValue(input);

// Independently recomputes the pinned digest input strings via the Crypto service NodeServices provides.
const sha256Hex = Effect.fn("CodexCredentials.test.sha256Hex")(function* (text: string) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

const makeTempDir = Effect.fn("CodexCredentials.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTextFile = Effect.fn("CodexCredentials.test.writeTextFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

it.layer(NodeServices.layer)("CodexCredentials", (it) => {
  describe("resolveCodexCredentialFingerprint", () => {
    it.effect("produces different digests for different ChatGPT account IDs", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const aliceHome = yield* makeTempDir("codex-creds-alice-");
        const bobHome = yield* makeTempDir("codex-creds-bob-");

        yield* writeTextFile(
          path.join(aliceHome, "auth.json"),
          JSON.stringify({
            auth_mode: "chatgpt",
            OPENAI_API_KEY: null,
            tokens: {
              account_id: "acc-alice-123",
              access_token: "token-alice",
            },
          }),
        );
        yield* writeTextFile(
          path.join(bobHome, "auth.json"),
          JSON.stringify({
            auth_mode: "chatgpt",
            OPENAI_API_KEY: null,
            tokens: {
              account_id: "acc-bob-456",
              access_token: "token-bob",
            },
          }),
        );

        const aliceFingerprint = yield* resolveCodexCredentialFingerprint(
          decodeCodexSettings({ homePath: aliceHome }),
        );
        const bobFingerprint = yield* resolveCodexCredentialFingerprint(
          decodeCodexSettings({ homePath: bobHome }),
        );

        const expectedAliceDigest = yield* sha256Hex("codex:chatgpt\0acc-alice-123");
        const expectedBobDigest = yield* sha256Hex("codex:chatgpt\0acc-bob-456");

        expect(aliceFingerprint).toBe(expectedAliceDigest);
        expect(bobFingerprint).toBe(expectedBobDigest);
        expect(expectedAliceDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(expectedBobDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(aliceFingerprint).not.toStrictEqual(bobFingerprint);
      }),
    );

    it.effect("preserves digest across token rotation when account ID is unchanged", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const home = yield* makeTempDir("codex-creds-rotation-");
        const authPath = path.join(home, "auth.json");

        yield* writeTextFile(
          authPath,
          JSON.stringify({
            auth_mode: "chatgpt",
            OPENAI_API_KEY: null,
            tokens: {
              account_id: "acc-stable-id",
              access_token: "access-token-initial",
              refresh_token: "refresh-token-initial",
              id_token: "id-token-initial",
              last_refresh: "2026-01-01T00:00:00.000Z",
            },
          }),
        );

        const initialFingerprint = yield* resolveCodexCredentialFingerprint(
          decodeCodexSettings({ homePath: home }),
        );

        yield* writeTextFile(
          authPath,
          JSON.stringify({
            auth_mode: "chatgpt",
            OPENAI_API_KEY: null,
            tokens: {
              account_id: "acc-stable-id",
              access_token: "access-token-refreshed",
              refresh_token: "refresh-token-refreshed",
              id_token: "id-token-different",
              last_refresh: "2026-02-01T12:00:00.000Z",
            },
          }),
        );

        const rotatedFingerprint = yield* resolveCodexCredentialFingerprint(
          decodeCodexSettings({ homePath: home }),
        );

        const expectedDigest = yield* sha256Hex("codex:chatgpt\0acc-stable-id");

        expect(initialFingerprint).toBe(expectedDigest);
        expect(rotatedFingerprint).toStrictEqual(initialFingerprint);
      }),
    );

    it.effect(
      "separates the missing-file surface (null) from unreadable states (undefined) without throwing",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const home = yield* makeTempDir("codex-creds-failures-");
          const settings = decodeCodexSettings({ homePath: home });

          const missingResult = yield* resolveCodexCredentialFingerprint(settings);
          expect(missingResult).toBe(null);

          const authPath = path.join(home, "auth.json");
          yield* writeTextFile(authPath, '{"tokens": {"account_');
          const tornResult = yield* resolveCodexCredentialFingerprint(settings);
          expect(tornResult).toBe(undefined);

          yield* writeTextFile(
            authPath,
            JSON.stringify({
              tokens: { account_id: 12345 },
            }),
          );
          const nonStringAccountResult = yield* resolveCodexCredentialFingerprint(settings);
          expect(nonStringAccountResult).toBe(undefined);

          yield* writeTextFile(authPath, JSON.stringify({}));
          const credentialFreeResult = yield* resolveCodexCredentialFingerprint(settings);
          expect(credentialFreeResult).toBe(null);

          yield* fileSystem.remove(authPath, { recursive: true });
          yield* fileSystem.makeDirectory(authPath);
          const dirInsteadOfFileResult = yield* resolveCodexCredentialFingerprint(settings);
          expect(dirInsteadOfFileResult).toBe(undefined);
          yield* fileSystem.remove(authPath, { recursive: true });

          yield* writeTextFile(
            authPath,
            JSON.stringify({
              tokens: { account_id: "" },
            }),
          );
          const emptyAccountResult = yield* resolveCodexCredentialFingerprint(settings);
          expect(emptyAccountResult).toBe(null);

          yield* writeTextFile(
            authPath,
            JSON.stringify({
              OPENAI_API_KEY: "   \t\n  ",
            }),
          );
          const whitespaceKeyResult = yield* resolveCodexCredentialFingerprint(settings);
          expect(whitespaceKeyResult).toBe(null);
        }),
    );

    it.effect(
      "computes digest for API key mode and detects key changes while ignoring whitespace",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const home = yield* makeTempDir("codex-creds-apikey-");
          const authPath = path.join(home, "auth.json");
          const settings = decodeCodexSettings({ homePath: home });

          yield* writeTextFile(
            authPath,
            JSON.stringify({
              OPENAI_API_KEY: "sk-proj-testkey1",
            }),
          );
          const key1Fingerprint = yield* resolveCodexCredentialFingerprint(settings);

          yield* writeTextFile(
            authPath,
            JSON.stringify({
              OPENAI_API_KEY: "  sk-proj-testkey1  \n",
            }),
          );
          const key1PaddedFingerprint = yield* resolveCodexCredentialFingerprint(settings);

          yield* writeTextFile(
            authPath,
            JSON.stringify({
              OPENAI_API_KEY: "sk-proj-testkey2",
            }),
          );
          const key2Fingerprint = yield* resolveCodexCredentialFingerprint(settings);

          yield* writeTextFile(
            authPath,
            JSON.stringify({
              OPENAI_API_KEY: null,
            }),
          );
          const nullKeyFingerprint = yield* resolveCodexCredentialFingerprint(settings);

          const expectedKey1Digest = yield* sha256Hex("codex:api_key\0sk-proj-testkey1");
          const expectedKey2Digest = yield* sha256Hex("codex:api_key\0sk-proj-testkey2");

          expect(key1Fingerprint).toBe(expectedKey1Digest);
          expect(expectedKey1Digest).toMatch(/^[0-9a-f]{64}$/);
          expect(key1PaddedFingerprint).toStrictEqual(key1Fingerprint);
          expect(key2Fingerprint).toBe(expectedKey2Digest);
          expect(key2Fingerprint).not.toStrictEqual(key1Fingerprint);
          expect(nullKeyFingerprint).toBe(null);
        }),
    );

    it.effect("tolerates unknown extra keys in auth.json", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const cleanHome = yield* makeTempDir("codex-creds-clean-");
        const extraKeysHome = yield* makeTempDir("codex-creds-extra-");

        yield* writeTextFile(
          path.join(cleanHome, "auth.json"),
          JSON.stringify({
            tokens: {
              account_id: "acc-enterprise-42",
            },
          }),
        );

        yield* writeTextFile(
          path.join(extraKeysHome, "auth.json"),
          JSON.stringify({
            auth_mode: "chatgpt",
            OPENAI_API_KEY: null,
            tokens: {
              account_id: "acc-enterprise-42",
              id_token: "token",
            },
            plan: "enterprise-tier",
            user_id: "user-internal-99",
            last_refresh: "2026-03-01T00:00:00Z",
            third_party_tool_metadata: { enabled: true, version: 3 },
          }),
        );

        const cleanFingerprint = yield* resolveCodexCredentialFingerprint(
          decodeCodexSettings({ homePath: cleanHome }),
        );
        const extraFingerprint = yield* resolveCodexCredentialFingerprint(
          decodeCodexSettings({ homePath: extraKeysHome }),
        );

        const expectedDigest = yield* sha256Hex("codex:chatgpt\0acc-enterprise-42");

        expect(cleanFingerprint).toBe(expectedDigest);
        expect(extraFingerprint).toStrictEqual(cleanFingerprint);
      }),
    );

    it.effect("prioritizes ChatGPT account ID over OPENAI_API_KEY when both are present", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const home = yield* makeTempDir("codex-creds-both-");
        const authPath = path.join(home, "auth.json");
        const settings = decodeCodexSettings({ homePath: home });

        yield* writeTextFile(
          authPath,
          JSON.stringify({
            OPENAI_API_KEY: "sk-proj-should-be-ignored",
            tokens: {
              account_id: "acc-priority-chatgpt",
            },
          }),
        );

        const fingerprint = yield* resolveCodexCredentialFingerprint(settings);
        const expectedDigest = yield* sha256Hex("codex:chatgpt\0acc-priority-chatgpt");

        expect(fingerprint).toBe(expectedDigest);
      }),
    );
  });

  describe("resolveEffectiveCodexAuthJsonPath", () => {
    it.effect("resolves effective path based on homePath", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const customHome = yield* makeTempDir("codex-path-home-");
        const settings = decodeCodexSettings({ homePath: customHome });

        const resolved = yield* resolveEffectiveCodexAuthJsonPath(settings);
        expect(resolved).toBe(path.join(customHome, "auth.json"));
      }),
    );

    it.effect("resolves effective path based on shadowHomePath", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("codex-path-shared-");
        const shadowRoot = yield* makeTempDir("codex-path-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");
        const settings = decodeCodexSettings({
          homePath: sharedHome,
          shadowHomePath: shadowHome,
        });

        const resolved = yield* resolveEffectiveCodexAuthJsonPath(settings);
        expect(resolved).toBe(path.join(shadowHome, "auth.json"));
      }),
    );

    it.effect("resolves effective path from CODEX_HOME environment when paths are empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const envHome = yield* makeTempDir("codex-path-env-");
        const settings = decodeCodexSettings({
          homePath: "",
          shadowHomePath: "",
        });

        const resolved = yield* resolveEffectiveCodexAuthJsonPath(settings, {
          CODEX_HOME: envHome,
        });
        expect(resolved).toBe(path.join(envHome, "auth.json"));
      }),
    );

    it.effect("resolves effective path from home directory when config and env are empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fakeUserHome = yield* makeTempDir("codex-path-userhome-");
        const settings = decodeCodexSettings({
          homePath: "",
          shadowHomePath: "",
        });

        const resolved = yield* resolveEffectiveCodexAuthJsonPath(settings, {}).pipe(
          Effect.provideService(HostProcess.HomeDirectory, fakeUserHome),
        );
        expect(resolved).toBe(path.join(fakeUserHome, ".codex", "auth.json"));
      }),
    );
  });
});
