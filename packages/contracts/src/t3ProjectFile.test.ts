import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { T3ProjectFile } from "./t3ProjectFile.ts";

const decode = Schema.decodeUnknownSync(T3ProjectFile);

describe("T3ProjectFile", () => {
  it("decodes a full project file", () => {
    const decoded = decode({
      $schema: "https://t3.codes/schema/t3.json",
      iconPath: "assets/logo.svg",
      scripts: [
        {
          name: "Dev",
          command: "pnpm dev",
          icon: "play",
          runOnWorktreeCreate: false,
          previewUrl: "http://localhost:3000",
          autoOpenPreview: true,
        },
        { name: "Test", command: "pnpm test" },
      ],
    });

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts).toHaveLength(2);
    expect(decoded.scripts?.[1]).toEqual({ name: "Test", command: "pnpm test" });
  });

  it("decodes an empty object and ignores unknown fields", () => {
    expect(decode({})).toEqual({});
    expect(decode({ futureField: true })).toEqual({});
  });

  it("trims icon paths and script fields", () => {
    const decoded = decode({
      iconPath: " assets/logo.svg ",
      scripts: [{ name: " Dev ", command: " pnpm dev " }],
    });

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });

  it("decodes bounded checked-in native agent and rule references", () => {
    const decoded = decode({
      agents: [{ id: " reviewer ", path: " .t3/agents/reviewer.md " }],
      rules: [{ id: " review-rules ", path: " .t3/rules/review.md " }],
    });

    expect(decoded.agents).toEqual([{ id: "reviewer", path: ".t3/agents/reviewer.md" }]);
    expect(decoded.rules).toEqual([{ id: "review-rules", path: ".t3/rules/review.md" }]);
  });

  it("rejects more than 100 native agent or rule references", () => {
    const references = Array.from({ length: 101 }, (_, index) => ({
      id: `agent-${index}`,
      path: `.t3/agents/${index}.md`,
    }));

    expect(() => decode({ agents: references })).toThrow();
    expect(() => decode({ rules: references })).toThrow();
  });

  it("rejects scripts without a command", () => {
    expect(() => decode({ scripts: [{ name: "Dev" }] })).toThrow();
  });

  it("rejects unknown script icons", () => {
    expect(() =>
      decode({ scripts: [{ name: "Dev", command: "pnpm dev", icon: "rocket" }] }),
    ).toThrow();
  });

  it("decodes defaultThreadEnvMode and rejects unknown modes", () => {
    expect(decode({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe("worktree");
    expect(decode({ defaultThreadEnvMode: "local" }).defaultThreadEnvMode).toBe("local");
    expect(() => decode({ defaultThreadEnvMode: "remote" })).toThrow();
  });
});
