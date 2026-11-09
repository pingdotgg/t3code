import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";

import { ZcodeSettings } from "../settings.ts";
import { checkZcodeProviderStatus, zcodeAuthFromCredentials } from "./status.ts";

const settings = Schema.decodeSync(ZcodeSettings);
const BASE_ENV = { PATH: process.env.PATH };

const credentialsWithActiveProvider = JSON.stringify([
  ["oauth:active_provider", "account:zai-individual-coding-plan"],
  ["oauth:account:zai-individual-coding-plan", { accessToken: "redacted" }],
]);

const fakeDoctor = (source: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-status-test-" });
    return writeFakeCli({ directory, name: "zcode", source });
  });

const dataDirWithCredentials = (credentials: string | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-credentials-test-" });
    if (credentials !== null) {
      yield* fs.makeDirectory(`${root}/.zcode/v2`, { recursive: true });
      yield* fs.writeFileString(`${root}/.zcode/v2/credentials.json`, credentials);
    }
    return root;
  });

describe("zcodeAuthFromCredentials", () => {
  it("reads the credential store's active provider", () => {
    assert.equal(
      zcodeAuthFromCredentials(JSON.parse(credentialsWithActiveProvider)),
      "authenticated",
    );
    assert.equal(zcodeAuthFromCredentials([]), "unauthenticated");
    assert.equal(zcodeAuthFromCredentials([["other", "value"]]), "unauthenticated");
    assert.equal(zcodeAuthFromCredentials([["oauth:active_provider", ""]]), "unauthenticated");
    assert.equal(zcodeAuthFromCredentials(["oauth:active_provider"]), "unauthenticated");
    assert.equal(zcodeAuthFromCredentials(undefined), "unknown");
    // A readable store without an active provider is a not-signed-in store, whatever the shape.
    assert.equal(zcodeAuthFromCredentials({}), "unauthenticated");
    assert.equal(zcodeAuthFromCredentials({ oauth: true }), "unauthenticated");
    assert.equal(zcodeAuthFromCredentials({ "oauth:active_provider": "zai" }), "authenticated");
  });
});

it.layer(NodeServices.layer)("Zcode status", (it) => {
  it.effect("reports an authenticated ready provider from doctor JSON", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeDoctor(
          'process.stdout.write(\'{"cli":{"version":"3.17.2"}}\');process.exit(0);',
        );
        const dataDir = yield* dataDirWithCredentials(credentialsWithActiveProvider);
        const snapshot = yield* checkZcodeProviderStatus(settings({ enabled: true, binaryPath }), {
          ...BASE_ENV,
          ZCODE_DATA_BASE_DIR: dataDir,
        });
        assert.equal(snapshot.enabled, true);
        assert.equal(snapshot.installed, true);
        assert.equal(snapshot.version, "3.17.2");
        assert.equal(snapshot.status, "ready");
        assert.equal(snapshot.auth.status, "authenticated");
        assert.equal(snapshot.message, undefined);
      }),
    ),
  );

  it.effect("flags a signed-out CLI as warning", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeDoctor(
          'process.stdout.write(\'{"cli":{"version":"3.17.2"}}\');process.exit(0);',
        );
        const dataDir = yield* dataDirWithCredentials(null);
        const snapshot = yield* checkZcodeProviderStatus(settings({ enabled: true, binaryPath }), {
          ...BASE_ENV,
          ZCODE_DATA_BASE_DIR: dataDir,
        });
        assert.equal(snapshot.installed, true);
        assert.equal(snapshot.version, "3.17.2");
        assert.equal(snapshot.status, "warning");
        assert.equal(snapshot.auth.status, "unauthenticated");
        assert.match(snapshot.message ?? "", /zcode login/);
      }),
    ),
  );

  it.effect("falls back to plain stdout when doctor output is not JSON", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeDoctor(
          'process.stdout.write("zcode agent CLI 0.17.1\\n");process.exit(0);',
        );
        const dataDir = yield* dataDirWithCredentials(credentialsWithActiveProvider);
        const snapshot = yield* checkZcodeProviderStatus(settings({ enabled: true, binaryPath }), {
          ...BASE_ENV,
          ZCODE_DATA_BASE_DIR: dataDir,
        });
        assert.equal(snapshot.version, "0.17.1");
        assert.equal(snapshot.status, "ready");
      }),
    ),
  );

  it.effect("reports an unsupported version as error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeDoctor(
          'process.stdout.write(\'{"cli":{"version":"0.16.0"}}\');process.exit(0);',
        );
        const dataDir = yield* dataDirWithCredentials(credentialsWithActiveProvider);
        const snapshot = yield* checkZcodeProviderStatus(settings({ enabled: true, binaryPath }), {
          ...BASE_ENV,
          ZCODE_DATA_BASE_DIR: dataDir,
        });
        assert.equal(snapshot.installed, true);
        assert.equal(snapshot.version, "0.16.0");
        assert.equal(snapshot.status, "error");
        assert.equal(snapshot.auth.status, "unknown");
        assert.match(snapshot.message ?? "", /unsupported/i);
      }),
    ),
  );

  it.effect("reports a failing doctor run without leaking its stderr", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeDoctor(
          'process.stderr.write("secret-doctor-value");process.exit(2);',
        );
        const dataDir = yield* dataDirWithCredentials(null);
        const snapshot = yield* checkZcodeProviderStatus(settings({ enabled: true, binaryPath }), {
          ...BASE_ENV,
          ZCODE_DATA_BASE_DIR: dataDir,
        });
        assert.equal(snapshot.installed, true);
        assert.equal(snapshot.version, null);
        assert.equal(snapshot.status, "error");
        assert.equal(snapshot.message ?? "", "ZCode CLI is installed but failed to run.");
        assert.equal((snapshot.message ?? "").includes("secret-doctor-value"), false);
      }),
    ),
  );

  it.effect("reports a missing binary as uninstalled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const snapshot = yield* checkZcodeProviderStatus(
          settings({ enabled: true, binaryPath: "/nonexistent/zcode-missing" }),
          BASE_ENV,
        );
        assert.equal(snapshot.installed, false);
        assert.equal(snapshot.version, null);
        assert.equal(snapshot.status, "error");
        assert.match(snapshot.message ?? "", /not installed or not on PATH/);
      }),
    ),
  );

  it.effect("skips probing while the provider is disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const snapshot = yield* checkZcodeProviderStatus(
          settings({ enabled: false, binaryPath: "/nonexistent/zcode-missing" }),
          BASE_ENV,
        );
        assert.equal(snapshot.enabled, false);
        assert.equal(snapshot.installed, false);
        assert.equal(snapshot.status, "disabled");
        assert.match(snapshot.message ?? "", /disabled/i);
      }),
    ),
  );
});
