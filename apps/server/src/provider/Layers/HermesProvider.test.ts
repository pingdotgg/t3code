import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HermesSettings } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildHermesProviderSnapshot,
  checkHermesProviderStatus,
  getHermesFallbackModels,
  parseHermesCliVersion,
  parseHermesVersionOutput,
} from "./HermesProvider.ts";

const decodeHermesSettings = Schema.decodeUnknownSync(HermesSettings);
const baseHermesSettings = decodeHermesSettings({ enabled: true });

const resolveMockAgentPath = Effect.fn("resolveMockAgentPath")(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url));
});

const hermesVersionBanner = "Hermes Agent v0.21.0 (2026.8.31) · upstream f98f5e74";

/**
 * A minimal newline-delimited JSON-RPC agent whose `session/new` advertises an
 * empty model catalog — the one shape the shared ACP mock agent cannot
 * produce.
 */
const emptyModelsAgentSource = `import * as readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const respond = (result) =>
    process.stdout.write(\`\${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\\n\`);
  switch (message.method) {
    case "initialize":
      respond({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: "custom", name: "Custom", description: null }],
      });
      break;
    case "authenticate":
      respond({});
      break;
    case "session/new":
      respond({
        sessionId: "hermes-empty-models",
        models: { currentModelId: "default", availableModels: [] },
      });
      break;
    default:
      respond({});
  }
});
`;

/**
 * Wrap an ACP agent in a shell script that answers `--version` like the real
 * Hermes CLI. `versionExitCode` breaks the version probe; `acp` selects what
 * backs the discovery leg.
 */
const makeMockHermesWrapper = Effect.fn("makeMockHermesWrapper")(function* (options?: {
  readonly versionExitCode?: number;
  readonly acp?: "mock-agent" | "empty-models" | "fail";
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "hermes-provider-mock-",
  });

  const acpCommand = yield* Effect.gen(function* () {
    if (options?.acp === "fail") {
      return "exit 1";
    }
    if (options?.acp === "empty-models") {
      const agentPath = path.join(dir, "empty-models-agent.mjs");
      yield* fileSystem.writeFileString(agentPath, emptyModelsAgentSource);
      return `exec ${["node", agentPath].map((arg) => JSON.stringify(arg)).join(" ")} "$@"`;
    }
    const mockAgentPath = yield* resolveMockAgentPath();
    return `exec ${["node", mockAgentPath].map((arg) => JSON.stringify(arg)).join(" ")} "$@"`;
  });

  const versionCommand =
    options?.versionExitCode !== undefined
      ? `exit ${options.versionExitCode}`
      : `${["printf", "%s\n", hermesVersionBanner]
          .map((arg) => JSON.stringify(arg))
          .join(" ")}\n  exit 0`;
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  ${versionCommand}
fi
${acpCommand}
`;
  const wrapperPath = path.join(dir, "fake-hermes.sh");
  yield* fileSystem.writeFileString(wrapperPath, script);
  yield* fileSystem.chmod(wrapperPath, 0o755);
  return { wrapperPath, requestLogPath: path.join(dir, "requests.ndjson") };
});

const missingHermesBinaryPath = "/definitely/not/installed/t3-hermes-agent";
const hermesAcpDiscoveryFailedMessage = [
  "Hermes ACP model discovery failed.",
  "Hermes may not be configured on this machine yet; run `hermes setup` (or `hermes acp --setup`), then retry.",
  "Check server logs for ACP details.",
].join(" ");

describe("parseHermesCliVersion", () => {
  it("extracts the semver from the real `hermes --version` banner, not the build date", () => {
    expect(parseHermesCliVersion(hermesVersionBanner)).toBe("0.21.0");
  });

  it("falls back to the generic parser when the version is not v-prefixed", () => {
    expect(parseHermesCliVersion("hermes 0.21.0")).toBe("0.21.0");
  });

  it("returns null when no version is present", () => {
    expect(parseHermesCliVersion("no version here")).toBeNull();
  });
});

describe("parseHermesVersionOutput", () => {
  it("treats a zero exit as a ready probe with unknown auth", () => {
    expect(
      parseHermesVersionOutput({
        stdout: hermesVersionBanner,
        stderr: "",
        code: 0,
      }),
    ).toEqual({
      version: "0.21.0",
      status: "ready",
      auth: { status: "unknown" },
    });
  });

  it("treats a non-zero exit as an error probe", () => {
    expect(
      parseHermesVersionOutput({
        stdout: "",
        stderr: "boom",
        code: 1,
      }),
    ).toMatchObject({
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "Hermes Agent CLI is installed but failed to run.",
    });
  });
});

describe("getHermesFallbackModels", () => {
  it("publishes the built-in default model plus custom models before ACP discovery", () => {
    expect(
      getHermesFallbackModels({
        customModels: ["anthropic:claude-fable-5"],
      }).map((model) => model.slug),
    ).toEqual(["default", "anthropic:claude-fable-5"]);
  });
});

it.layer(NodeServices.layer)("checkHermesProviderStatus", (it) => {
  it.effect("returns a disabled snapshot without probing the CLI", () =>
    Effect.gen(function* () {
      const provider = yield* checkHermesProviderStatus(
        decodeHermesSettings({ enabled: false, binaryPath: missingHermesBinaryPath }),
      );

      expect(provider).toMatchObject({
        enabled: false,
        installed: false,
        status: "disabled",
        auth: { status: "unknown" },
        message: "Hermes is disabled in T3 Code settings.",
      });
    }),
  );

  it.effect("reports a missing Hermes command without attempting ACP discovery", () =>
    Effect.gen(function* () {
      const provider = yield* checkHermesProviderStatus({
        ...baseHermesSettings,
        binaryPath: missingHermesBinaryPath,
      });

      expect(provider).toMatchObject({
        installed: false,
        status: "error",
        auth: { status: "unknown" },
        message: [
          `Hermes Agent command \`${missingHermesBinaryPath}\` was not found.`,
          `Install the Hermes Agent CLI, make sure \`${missingHermesBinaryPath}\` is on PATH, then restart T3 Code.`,
        ].join(" "),
      });
    }),
  );

  it.effect("skips ACP discovery when the version probe exits non-zero", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { wrapperPath, requestLogPath } = yield* makeMockHermesWrapper({ versionExitCode: 1 });

      const provider = yield* checkHermesProviderStatus(
        { ...baseHermesSettings, binaryPath: wrapperPath },
        { ...process.env, T3_ACP_REQUEST_LOG_PATH: requestLogPath },
      );

      expect(provider).toMatchObject({
        installed: true,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes Agent CLI is installed but failed to run.",
      });
      expect(provider.models.map((model) => model.slug)).toEqual(["default"]);
      // The ACP mock agent logs every request; an absent log proves the
      // `parsed.status === "ready"` gate skipped discovery entirely.
      expect(yield* fileSystem.exists(requestLogPath)).toBe(false);
    }),
  );

  it.effect("publishes discovered models and authenticated auth when ACP discovery succeeds", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { wrapperPath, requestLogPath } = yield* makeMockHermesWrapper();

      const provider = yield* checkHermesProviderStatus(
        { ...baseHermesSettings, binaryPath: wrapperPath },
        { ...process.env, T3_ACP_REQUEST_LOG_PATH: requestLogPath },
      );

      expect(provider).toMatchObject({
        installed: true,
        version: "0.21.0",
        status: "ready",
        auth: { status: "authenticated" },
      });
      expect(provider.message).toBeUndefined();
      // The shared ACP mock agent advertises a fixed grok-flavored catalog.
      expect(provider.models.map((model) => model.slug)).toEqual(["grok-build", "grok-mock-alt"]);
      // The mock agent logs every request before responding, so the log is
      // complete by the time the status check resolves.
      expect(yield* fileSystem.readFileString(requestLogPath)).toContain("initialize");
    }),
  );

  it.effect("downgrades to warning with fallback models when ACP discovery fails", () =>
    Effect.gen(function* () {
      const { wrapperPath } = yield* makeMockHermesWrapper({ acp: "fail" });

      const provider = yield* checkHermesProviderStatus({
        ...baseHermesSettings,
        binaryPath: wrapperPath,
      });

      expect(provider).toMatchObject({
        installed: true,
        version: "0.21.0",
        status: "warning",
        auth: { status: "unknown" },
        message: hermesAcpDiscoveryFailedMessage,
      });
      expect(provider.models.map((model) => model.slug)).toEqual(["default"]);
    }),
  );

  it.effect("marks auth authenticated but warns when discovery returns no models", () =>
    Effect.gen(function* () {
      const { wrapperPath } = yield* makeMockHermesWrapper({ acp: "empty-models" });

      const provider = yield* checkHermesProviderStatus({
        ...baseHermesSettings,
        binaryPath: wrapperPath,
      });

      expect(provider).toMatchObject({
        installed: true,
        version: "0.21.0",
        status: "warning",
        auth: { status: "authenticated" },
        message: "Hermes ACP model discovery returned no built-in models.",
      });
      expect(provider.models.map((model) => model.slug)).toEqual(["default"]);
    }),
  );
});

describe("buildHermesProviderSnapshot", () => {
  it("downgrades ready status to warning when ACP model discovery fails", () => {
    expect(
      buildHermesProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        hermesSettings: baseHermesSettings,
        parsed: {
          version: "0.21.0",
          status: "ready",
          auth: { status: "unknown" },
        },
        discoveryWarning: "Hermes ACP model discovery timed out after 15000ms.",
      }),
    ).toMatchObject({
      status: "warning",
      message: "Hermes ACP model discovery timed out after 15000ms.",
      models: [{ slug: "default", isCustom: false }],
    });
  });

  it("publishes discovered models without a warning when discovery succeeds", () => {
    expect(
      buildHermesProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        hermesSettings: baseHermesSettings,
        parsed: {
          version: "0.21.0",
          status: "ready",
          auth: { status: "authenticated" },
        },
        discoveredModels: [
          {
            slug: "moa:default",
            name: "MoA Default",
            isCustom: false,
            capabilities: createModelCapabilities({ optionDescriptors: [] }),
          },
        ],
      }),
    ).toMatchObject({
      status: "ready",
      auth: { status: "authenticated" },
      models: [{ slug: "moa:default", isCustom: false }],
    });
  });
});
