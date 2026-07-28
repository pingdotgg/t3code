import * as NodeServices from "@effect/platform-node/NodeServices";
import { OpenClawSettings } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildInitialOpenClawProviderSnapshot,
  checkOpenClawProviderStatus,
} from "./OpenClawProvider.ts";

const decodeSettings = Schema.decodeSync(OpenClawSettings);

describe("buildInitialOpenClawProviderSnapshot", () => {
  it.effect("is pending until the OpenClaw ACP probe completes", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialOpenClawProviderSnapshot(decodeSettings({}));
      expect(snapshot.displayName).toBe("OpenClaw");
      expect(snapshot.badgeLabel).toBe("ACP");
      expect(snapshot.message).toContain("OpenClaw ACP");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
    }),
  );
});

it.layer(NodeServices.layer)("checkOpenClawProviderStatus", (it) => {
  it.effect("gracefully reports an unavailable OpenClaw executable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-openclaw-missing-",
        });

        const snapshot = yield* checkOpenClawProviderStatus(
          decodeSettings({ binaryPath: path.join(directory, "openclaw") }),
        );
        expect(snapshot.installed).toBe(false);
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).toContain("not installed");
      }),
    ),
  );

  it.effect("rejects an OpenClaw executable without the ACP command", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-openclaw-no-acp-",
        });
        const executable = path.join(directory, "openclaw");
        yield* fs.writeFileString(
          executable,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then printf "OpenClaw 1.2.3\\n"; exit 0; fi',
            "exit 2",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(executable, 0o755);

        const snapshot = yield* checkOpenClawProviderStatus(
          decodeSettings({ binaryPath: executable }),
        );
        expect(snapshot.installed).toBe(true);
        expect(snapshot.version).toBe("1.2.3");
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).toContain("does not expose");
      }),
    ),
  );

  it.effect("reports ready after safe version and ACP help probes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-openclaw-acp-" });
        const executable = path.join(directory, "openclaw");
        yield* fs.writeFileString(
          executable,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then printf "OpenClaw 1.2.3\\n"; exit 0; fi',
            'if [ "$1" = "acp" ] && [ "$2" = "--help" ]; then printf "ACP over stdio\\n"; exit 0; fi',
            "exit 8",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(executable, 0o755);

        const snapshot = yield* checkOpenClawProviderStatus(
          decodeSettings({
            binaryPath: executable,
            customModels: ["custom/model"],
          }),
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.version).toBe("1.2.3");
        expect(snapshot.models.map((model) => model.slug)).toEqual(["default", "custom/model"]);
      }),
    ),
  );
});
