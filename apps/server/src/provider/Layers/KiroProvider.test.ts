import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { KiroSettings } from "@t3tools/contracts";

import { buildInitialKiroProviderSnapshot, checkKiroProviderStatus } from "./KiroProvider.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);

/**
 * Writes a stand-in `kiro-cli` whose behaviour per subcommand is scripted, so
 * the probe can be exercised without a real install or a real login.
 */
const writeFakeKiro = (script: {
  readonly version?: { readonly stdout?: string; readonly exit?: number };
  readonly whoami?: { readonly stdout?: string; readonly exit?: number };
  readonly listModels?: { readonly stdout?: string; readonly exit?: number };
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kiro-probe-" });
    const binaryPath = path.join(dir, "kiro-cli");
    const section = (
      matcher: string,
      config: { readonly stdout?: string; readonly exit?: number } | undefined,
    ) =>
      config === undefined
        ? // Unscripted subcommands behave like an unknown flag.
          [`${matcher}`, '  printf "unsupported\\n" >&2', "  exit 64", "  ;;"].join("\n")
        : [
            `${matcher}`,
            ...(config.stdout ? [`  cat <<'KIRO_EOF'\n${config.stdout}\nKIRO_EOF`] : []),
            `  exit ${config.exit ?? 0}`,
            "  ;;",
          ].join("\n");

    yield* fs.writeFileString(
      binaryPath,
      [
        "#!/bin/sh",
        'case "$1" in',
        section('"--version")', script.version),
        section('"whoami")', script.whoami),
        section('"chat")', script.listModels),
        "*)",
        '  printf "unknown subcommand\\n" >&2',
        "  exit 64",
        "  ;;",
        "esac",
        "",
      ].join("\n"),
    );
    yield* fs.chmod(binaryPath, 0o755);
    return binaryPath;
  });

const MODEL_LIST_JSON = JSON.stringify({
  models: [
    { model_name: "auto", model_id: "auto", description: "Models chosen by task" },
    { model_name: "claude-opus-5", model_id: "claude-opus-5", description: "Opus 5" },
    { model_name: "claude-haiku-4.5", model_id: "claude-haiku-4.5", description: "Haiku 4.5" },
  ],
  default_model: "auto",
});

const WHOAMI_JSON = [
  JSON.stringify({
    accountType: "IamIdentityCenter",
    email: "dev@example.com",
    region: "us-east-1",
  }),
  "",
  "Profile:",
  "aws-app-profile-kiro-000000000000",
].join("\n");

describe("buildInitialKiroProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when the instance is not enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKiroProviderSnapshot(
        decodeKiroSettings({ enabled: false }),
      );

      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
      expect(snapshot.badgeLabel).toBe("Early Access");
    }),
  );

  it.effect("returns a pending snapshot carrying the always-valid auto model", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKiroProviderSnapshot(
        decodeKiroSettings({ enabled: true }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Kiro");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["auto"]);
    }),
  );
});

it.layer(NodeServices.layer)("checkKiroProviderStatus", (it) => {
  it.effect("skips every probe while the instance is disabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKiroProviderStatus(
        decodeKiroSettings({ enabled: false, binaryPath: "/definitely/not/installed/kiro-cli" }),
      );

      expect(snapshot.status).toBe("disabled");
      expect(snapshot.auth.status).toBe("unknown");
    }),
  );

  it.effect("reports the CLI as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKiroProviderStatus(
        decodeKiroSettings({ enabled: true, binaryPath: "/definitely/not/installed/kiro-cli" }),
      );

      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("keeps stderr out of the message when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secret = "broken kiro install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* writeFakeKiro({
            version: { stdout: secret, exit: 3 },
          });
          return yield* checkKiroProviderStatus(decodeKiroSettings({ enabled: true, binaryPath }));
        }),
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Kiro CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secret);
    }),
  );

  it.effect("asks the user to log in when whoami exits non-zero", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* writeFakeKiro({
            version: { stdout: "kiro-cli 2.16.2" },
            whoami: { stdout: "Not logged in", exit: 1 },
          });
          return yield* checkKiroProviderStatus(decodeKiroSettings({ enabled: true, binaryPath }));
        }),
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("2.16.2");
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("kiro-cli login");
      // A logged-out user should not be offered a stale model catalog.
      expect(snapshot.models.map((model) => model.slug)).toEqual(["auto"]);
    }),
  );

  it.effect("reports account type and email from the whoami payload", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* writeFakeKiro({
            version: { stdout: "kiro-cli 2.16.2" },
            whoami: { stdout: WHOAMI_JSON },
            listModels: { stdout: MODEL_LIST_JSON },
          });
          return yield* checkKiroProviderStatus(decodeKiroSettings({ enabled: true, binaryPath }));
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "IamIdentityCenter",
        email: "dev@example.com",
      });
      expect(snapshot.message).toBeUndefined();
    }),
  );

  it.effect("publishes the live model catalog, keeping Kiro's dotted ids", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* writeFakeKiro({
            version: { stdout: "kiro-cli 2.16.2" },
            whoami: { stdout: WHOAMI_JSON },
            listModels: { stdout: MODEL_LIST_JSON },
          });
          return yield* checkKiroProviderStatus(decodeKiroSettings({ enabled: true, binaryPath }));
        }),
      );

      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "auto",
        "claude-opus-5",
        "claude-haiku-4.5",
      ]);
      expect(snapshot.models.every((model) => model.isCustom === false)).toBe(true);
    }),
  );

  it.effect("appends configured custom models to the discovered catalog", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* writeFakeKiro({
            version: { stdout: "kiro-cli 2.16.2" },
            whoami: { stdout: WHOAMI_JSON },
            listModels: { stdout: MODEL_LIST_JSON },
          });
          return yield* checkKiroProviderStatus(
            decodeKiroSettings({
              enabled: true,
              binaryPath,
              customModels: ["some-internal-model", "auto"],
            }),
          );
        }),
      );

      const slugs = snapshot.models.map((model) => model.slug);
      expect(slugs).toContain("some-internal-model");
      // `auto` already ships in the catalog, so the duplicate is dropped.
      expect(slugs.filter((slug) => slug === "auto")).toHaveLength(1);
      expect(snapshot.models.find((model) => model.slug === "some-internal-model")?.isCustom).toBe(
        true,
      );
    }),
  );

  it.effect("stays ready but says so when the model list cannot be read", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* writeFakeKiro({
            version: { stdout: "kiro-cli 2.16.2" },
            whoami: { stdout: WHOAMI_JSON },
            listModels: { stdout: "not json at all", exit: 0 },
          });
          return yield* checkKiroProviderStatus(decodeKiroSettings({ enabled: true, binaryPath }));
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["auto"]);
      expect(snapshot.message).toContain("model list could not be read");
    }),
  );

  it.effect("treats a reshaped whoami payload as authenticated without detail", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* writeFakeKiro({
            version: { stdout: "kiro-cli 2.16.2" },
            whoami: { stdout: "Logged in with Builder ID", exit: 0 },
            listModels: { stdout: MODEL_LIST_JSON },
          });
          return yield* checkKiroProviderStatus(decodeKiroSettings({ enabled: true, binaryPath }));
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth).toEqual({ status: "authenticated" });
    }),
  );
});
