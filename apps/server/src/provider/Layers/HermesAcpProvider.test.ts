import * as NodeServices from "@effect/platform-node/NodeServices";
import { HermesAcpSettings } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildInitialHermesAcpProviderSnapshot,
  checkHermesAcpProviderStatus,
} from "./HermesAcpProvider.ts";

const decodeSettings = Schema.decodeSync(HermesAcpSettings);

describe("buildInitialHermesAcpProviderSnapshot", () => {
  it.effect("keeps Hermes in Code distinct and pending until its ACP probe completes", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesAcpProviderSnapshot(decodeSettings({}));
      expect(snapshot.displayName).toBe("Hermes in Code");
      expect(snapshot.badgeLabel).toBe("ACP");
      expect(snapshot.message).toContain("Hermes ACP");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
    }),
  );
});

it.layer(NodeServices.layer)("checkHermesAcpProviderStatus", (it) => {
  it.effect("rejects a Hermes executable without the ACP command", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-no-acp-" });
        const executable = path.join(directory, "hermes");
        yield* fs.writeFileString(executable, "#!/bin/sh\nexit 2\n");
        yield* fs.chmod(executable, 0o755);

        const snapshot = yield* checkHermesAcpProviderStatus(
          decodeSettings({ binaryPath: executable }),
        );
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).toContain("does not expose");
      }),
    ),
  );

  it.effect("reports ready only when both ACP version and dependency checks pass", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-acp-" });
        const executable = path.join(directory, "hermes");
        yield* fs.writeFileString(
          executable,
          [
            "#!/bin/sh",
            'if [ "$1" != "acp" ]; then exit 9; fi',
            'if [ "$2" = "--version" ]; then printf "0.19.0\\n"; exit 0; fi',
            'if [ "$2" = "--check" ]; then printf "Hermes ACP check OK\\n"; exit 0; fi',
            "exit 8",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(executable, 0o755);

        const snapshot = yield* checkHermesAcpProviderStatus(
          decodeSettings({
            binaryPath: executable,
            customModels: ["custom/model"],
          }),
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.version).toBe("0.19.0");
        expect(snapshot.models.map((model) => model.slug)).toEqual(["default", "custom/model"]);
      }),
    ),
  );
});
