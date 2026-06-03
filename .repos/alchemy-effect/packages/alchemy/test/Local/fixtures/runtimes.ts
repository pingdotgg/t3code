import { spawnSync } from "node:child_process";

export interface Runtime {
  readonly name: "bun" | "node";
  readonly argv: (entry: string) => Array<string>;
  readonly available: boolean;
}

const hasBin = (bin: string): boolean => {
  try {
    const r = spawnSync("which", [bin], { encoding: "utf-8" });
    return r.status === 0 && Boolean(r.stdout?.trim());
  } catch {
    return false;
  }
};

export const runtimes = (): Array<Runtime> => [
  {
    name: "bun",
    argv: (entry) => ["bun", "run", entry],
    available: hasBin("bun"),
  },
  {
    name: "node",
    argv: (entry) => [
      "node",
      "--experimental-transform-types",
      "--no-warnings=ExperimentalWarning",
      entry,
    ],
    available: hasBin("node"),
  },
];
