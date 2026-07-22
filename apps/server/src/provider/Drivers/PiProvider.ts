import { PiSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ProcessRunner } from "../../processRunner.ts";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";
import { parsePiVersion, PI_MINIMUM_VERSION } from "./PiRuntime.ts";

const PI_DRIVER = ProviderDriverKind.make("pi");
const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
} as const;

export const makePendingPiProvider = (settings: PiSettings): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      driver: PI_DRIVER,
      presentation: PI_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Pi provider status has not been checked in this session yet."
          : "Pi is disabled in T3 Code settings.",
      },
    });
  });

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  settings: PiSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, ProcessRunner> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  if (!settings.enabled) {
    return buildServerProvider({
      driver: PI_DRIVER,
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const processRunner = yield* ProcessRunner;
  const result = yield* processRunner
    .run({ command: settings.binaryPath || "pi", args: ["--version"], env: environment })
    .pipe(Effect.either);
  if (result._tag === "Left") {
    return buildServerProvider({
      driver: PI_DRIVER,
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi CLI (${settings.binaryPath || "pi"}) is not installed or could not be started. Check the binary path.`,
      },
    });
  }

  const parsed = parsePiVersion(`${result.right.stdout}\n${result.right.stderr}`);
  if (parsed._tag === "Invalid") {
    return buildServerProvider({
      driver: PI_DRIVER,
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Could not determine the Pi CLI version. Check that the selected binary is Pi.",
      },
    });
  }

  return buildServerProvider({
    driver: PI_DRIVER,
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models: [],
    probe: {
      installed: true,
      version: parsed.version,
      status: parsed._tag === "Supported" ? "ready" : "error",
      auth: { status: "unknown" },
      message:
        parsed._tag === "Supported"
          ? undefined
          : `Pi v${parsed.version} is too old. Upgrade to v${PI_MINIMUM_VERSION} or later.`,
    },
  });
});
