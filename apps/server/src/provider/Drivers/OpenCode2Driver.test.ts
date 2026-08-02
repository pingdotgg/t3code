import { expect, it } from "@effect/vitest";

import { openCode2ProviderMaintenanceResolver } from "./OpenCode2Driver.ts";

const provider = "opencode2";
const packageName = "@opencode-ai/cli";

it.each([
  {
    manager: "npm",
    commandPath: "/usr/local/lib/node_modules/@opencode-ai/cli/bin/opencode2.exe",
    command: "npm install -g @opencode-ai/cli@next",
    executable: "npm",
    args: ["install", "-g", "@opencode-ai/cli@next"],
    lockKey: "npm-global",
  },
  {
    manager: "Bun",
    commandPath: "/home/test/.bun/bin/opencode2",
    command: "bun add -g --trust @opencode-ai/cli@next",
    executable: "bun",
    args: ["add", "-g", "--trust", "@opencode-ai/cli@next"],
    lockKey: "bun-global",
  },
  {
    manager: "pnpm",
    commandPath: "/home/test/.local/share/pnpm/opencode2",
    command: "pnpm add -g @opencode-ai/cli@next --allow-build=@opencode-ai/cli",
    executable: "pnpm",
    args: ["add", "-g", "@opencode-ai/cli@next", "--allow-build=@opencode-ai/cli"],
    lockKey: "pnpm-global",
  },
  {
    manager: "Vite Plus",
    commandPath: "/home/test/.vite-plus/bin/opencode2",
    command: "vp i -g @opencode-ai/cli@next",
    executable: "vp",
    args: ["i", "-g", "@opencode-ai/cli@next"],
    lockKey: "vite-plus-global",
  },
])("uses $manager to update a package-managed opencode2 executable", (expected) => {
  const capabilities = openCode2ProviderMaintenanceResolver({ serverUrl: "" }).resolve({
    binaryPath: "opencode2",
    resolvedCommandPath: expected.commandPath,
  });

  expect(capabilities).toEqual({
    provider,
    packageName,
    npmDistTag: "next",
    update: {
      command: expected.command,
      executable: expected.executable,
      args: expected.args,
      lockKey: expected.lockKey,
    },
  });
});

it("keeps custom OpenCode 2 executable paths manual-only", () => {
  expect(
    openCode2ProviderMaintenanceResolver({ serverUrl: "" }).resolve({
      binaryPath: "/opt/opencode-dev/opencode2",
      resolvedCommandPath: "/opt/opencode-dev/opencode2",
    }),
  ).toEqual({
    provider,
    packageName,
    npmDistTag: "next",
    update: null,
  });
});

it("keeps externally managed OpenCode 2 servers manual-only", () => {
  expect(
    openCode2ProviderMaintenanceResolver({ serverUrl: "http://127.0.0.1:4096" }).resolve({
      binaryPath: "opencode2",
      resolvedCommandPath: "/home/test/.bun/bin/opencode2",
    }),
  ).toEqual({
    provider,
    packageName,
    npmDistTag: "next",
    update: null,
  });
});
