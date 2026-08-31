import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { T3ProjectFile } from "./t3ProjectFile.ts";

const decode = Schema.decodeUnknownSync(T3ProjectFile);

describe("T3ProjectFile", () => {
  it("decodes a full project file", () => {
    const decoded = decode({
      $schema: "https://t3.codes/schema/t3.json",
      iconPath: "assets/logo.svg",
      textGeneration: {
        prompts: {
          commitMessage: "Use Conventional Commits.",
          changeRequest: "State the problem before the fix.",
          branchName: "Use fix/<slug> for bugs.",
          threadTitle: "Name the durable goal.",
          threadTitleRegeneration: "Keep the original subject when it is still accurate.",
        },
      },
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
    expect(decoded.textGeneration?.prompts?.branchName).toBe("Use fix/<slug> for bugs.");
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

  it("trims text generation prompts and ignores unknown prompt fields", () => {
    const decoded = decode({
      textGeneration: {
        prompts: {
          commitMessage: "  Use a direct subject.  ",
          futurePrompt: "future value",
        },
      },
    });

    expect(decoded.textGeneration?.prompts).toEqual({
      commitMessage: "Use a direct subject.",
    });
  });

  it("rejects empty or oversized text generation prompts", () => {
    expect(() => decode({ textGeneration: { prompts: { commitMessage: "   " } } })).toThrow();
    expect(() => decode({ textGeneration: { prompts: { changeRequest: false } } })).toThrow();
    expect(() =>
      decode({ textGeneration: { prompts: { branchName: "x".repeat(20_001) } } }),
    ).toThrow();
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
