import { describe, expect, it } from "@effect/vitest";

import { buildGeminiAcpSpawnInput } from "./GeminiAcpSupport.ts";

describe("buildGeminiAcpSpawnInput", () => {
  it("starts the Gemini CLI in ACP mode with the selected workspace", () => {
    expect(
      buildGeminiAcpSpawnInput({ binaryPath: "/usr/local/bin/gemini" }, "/tmp/project"),
    ).toEqual({
      command: "/usr/local/bin/gemini",
      args: ["--acp"],
      cwd: "/tmp/project",
    });
  });

  it("passes the configured provider environment to Gemini", () => {
    expect(
      buildGeminiAcpSpawnInput({ binaryPath: "gemini" }, "/tmp/project", {
        GOOGLE_GENAI_USE_VERTEXAI: "true",
      }),
    ).toEqual({
      command: "gemini",
      args: ["--acp"],
      cwd: "/tmp/project",
      env: { GOOGLE_GENAI_USE_VERTEXAI: "true" },
    });
  });
});
