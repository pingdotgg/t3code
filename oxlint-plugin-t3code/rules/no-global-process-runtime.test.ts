import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-global-process-runtime");

describe("t3code/no-global-process-runtime", () => {
  rule.valid(
    "allows injected host process references",
    `
      import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
      import * as Effect from "effect/Effect";

      export const isWindows = Effect.map(HostProcessPlatform, (platform) => platform === "win32");
    `,
  );

  rule.valid(
    "allows unrelated process members",
    `
      process.exitCode = 1;
      const nodeEnv = process.env.NODE_ENV;
    `,
  );

  rule.valid(
    "allows unrelated node os imports",
    `
      import { tmpdir } from "node:os";

      export const tempDirectory = tmpdir();
    `,
  );

  rule.invalid(
    "reports direct platform reads",
    `
      export const isWindows = process.platform === "win32";
    `,
    (output) => {
      assert.match(output, /Use HostProcessPlatform/);
    },
  );

  rule.invalid(
    "reports direct architecture reads",
    `
      export const isArm = process.arch === "arm64";
    `,
    (output) => {
      assert.match(output, /Use HostProcessArchitecture/);
    },
  );

  rule.invalid(
    "reports globalThis process platform reads",
    `
      export const terminalName = globalThis.process.platform === "win32" ? "xterm-color" : "xterm-256color";
    `,
  );

  rule.invalid(
    "reports node os namespace platform reads",
    `
      import * as NodeOS from "node:os";

      export const isWindows = NodeOS.platform() === "win32";
    `,
    (output) => {
      assert.match(output, /Use HostProcessPlatform/);
    },
  );

  rule.invalid(
    "reports renamed node os architecture imports",
    `
      import { arch as hostArch } from "node:os";

      export const isArm = hostArch() === "arm64";
    `,
    (output) => {
      assert.match(output, /Use HostProcessArchitecture/);
    },
  );

  rule.invalid(
    "reports default node os platform reads",
    `
      import os from "node:os";

      export const isWindows = os.platform() === "win32";
    `,
  );

  rule.valid(
    "allows a shadowed node os namespace parameter",
    `
      import * as NodeOS from "node:os";

      export const read = (NodeOS: { platform: () => string }) => NodeOS.platform();
    `,
  );

  rule.valid(
    "allows a shadowed node os namespace local const",
    `
      import * as NodeOS from "node:os";

      export const read = () => {
        const NodeOS = { platform: () => "win32" };
        return NodeOS.platform();
      };
    `,
  );

  rule.valid(
    "allows a shadowed node os namespace catch param",
    `
      import * as NodeOS from "node:os";

      export const read = () => {
        try {
          return "ok";
        } catch (NodeOS) {
          return (NodeOS as { platform: () => string }).platform();
        }
      };
    `,
  );

  rule.valid(
    "allows a shadowed node os namespace destructured parameter",
    `
      import * as NodeOS from "node:os";

      export const read = ({ NodeOS }: { NodeOS: { platform: () => string } }) => NodeOS.platform();
    `,
  );

  rule.valid(
    "allows a shadowed node process namespace parameter",
    `
      import * as NodeProcess from "node:process";

      export const read = (NodeProcess: { platform: string }) => NodeProcess.platform;
    `,
  );

  rule.valid(
    "allows a shadowed node process namespace destructured parameter",
    `
      import * as NodeProcess from "node:process";

      export const read = ({ NodeProcess }: { NodeProcess: { arch: string } }) => NodeProcess.arch;
    `,
  );

  rule.valid(
    "allows a shadowed node process namespace local const",
    `
      import * as NodeProcess from "node:process";

      export const read = () => {
        const NodeProcess = { arch: "arm64" };
        return NodeProcess.arch;
      };
    `,
  );

  rule.valid(
    "allows unrelated node process imports",
    `
      import * as NodeProcess from "node:process";

      export const nodeEnv = NodeProcess.env.NODE_ENV;
      export const args = NodeProcess.argv.slice(2);
    `,
  );

  rule.invalid(
    "reports node process namespace platform reads",
    `
      import * as NodeProcess from "node:process";

      export const isWindows = NodeProcess.platform === "win32";
    `,
    (output) => {
      assert.match(output, /Use HostProcessPlatform/);
    },
  );

  rule.invalid(
    "reports node process namespace architecture reads",
    `
      import * as NodeProcess from "node:process";

      export const isArm = NodeProcess.arch === "arm64";
    `,
    (output) => {
      assert.match(output, /Use HostProcessArchitecture/);
    },
  );

  rule.invalid(
    "reports default node process platform reads",
    `
      import nodeProcess from "node:process";

      export const isWindows = nodeProcess.platform === "win32";
    `,
  );
});
