import { describe, expect, it } from "vitest";

import {
  deriveToolActivityPresentation,
  extractLocalhostUrlsFromText,
  normalizeCommandActivityPayload,
} from "./toolActivity.ts";

describe("toolActivity", () => {
  it("extracts command from Codex-style data.item.command", () => {
    expect(
      normalizeCommandActivityPayload({
        data: { item: { command: "bun run dev" } },
      }).command,
    ).toBe("bun run dev");
  });

  it("extracts command from Claude-style input command and cmd", () => {
    expect(
      normalizeCommandActivityPayload({ data: { input: { command: "npm test" } } }).command,
    ).toBe("npm test");
    expect(normalizeCommandActivityPayload({ data: { input: { cmd: "pnpm lint" } } }).command).toBe(
      "pnpm lint",
    );
  });

  it("extracts command from Cursor ACP-style structured fields", () => {
    expect(normalizeCommandActivityPayload({ data: { command: "yarn dev" } }).command).toBe(
      "yarn dev",
    );
    expect(
      normalizeCommandActivityPayload({
        data: { rawInput: { executable: "bun", args: ["run", "dev"] } },
      }).command,
    ).toBe("bun run dev");
  });

  it("extracts command from OpenCode state.command and ignores state.output as command", () => {
    expect(
      normalizeCommandActivityPayload({ data: { state: { command: "go test ./..." } } }).command,
    ).toBe("go test ./...");
    expect(
      normalizeCommandActivityPayload({
        data: { state: { output: "VITE v5 ready in 100ms\nLocal: http://localhost:5173/" } },
      }).command,
    ).toBeNull();
  });

  it("does not treat multiline stdout or URL-only detail as command", () => {
    expect(
      normalizeCommandActivityPayload({
        detail: "VITE v5 ready\nLocal: http://localhost:5173/",
      }).command,
    ).toBeNull();
  });

  it("extracts command from safe shell-ish detail prefixes", () => {
    expect(normalizeCommandActivityPayload({ detail: "Bash: bun test" }).command).toBe("bun test");
  });

  it("unwraps shell command wrappers and preserves the raw command", () => {
    expect(
      normalizeCommandActivityPayload({
        data: {
          item: {
            command: "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'bun run lint'",
          },
        },
      }),
    ).toMatchObject({
      command: "bun run lint",
      rawCommand: "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'bun run lint'",
    });
  });

  it("extracts localhost URLs and normalizes 0.0.0.0 href", () => {
    expect(
      extractLocalhostUrlsFromText(
        "Local: http://localhost:5173/\nNetwork: http://0.0.0.0:5173/)",
        "output",
      ),
    ).toEqual([
      {
        url: "http://localhost:5173/",
        href: "http://localhost:5173/",
        host: "localhost",
        port: 5173,
        source: "output",
      },
    ]);
  });

  it("deduplicates URLs and ignores arbitrary remote URLs", () => {
    expect(
      extractLocalhostUrlsFromText(
        "http://localhost:3000 http://localhost:3000, https://example.com:443",
        "detail",
      ).map((url) => url.href),
    ).toEqual(["http://localhost:3000"]);
  });

  it("treats 127.0.0.1 and [::1] as localhost equivalents for dedup", () => {
    const urls = extractLocalhostUrlsFromText(
      "Local: http://localhost:3000 Loopback: http://127.0.0.1:3000 IPv6: http://[::1]:3000",
      "output",
    );
    expect(urls).toHaveLength(1);
    expect(urls[0]?.href).toBe("http://localhost:3000");
    expect(urls[0]?.url).toBe("http://localhost:3000");
  });

  it("normalizes 127.0.0.1 href but preserves the original visible url", () => {
    const urls = extractLocalhostUrlsFromText("http://127.0.0.1:5173/", "detail");
    expect(urls).toEqual([
      {
        url: "http://127.0.0.1:5173/",
        href: "http://localhost:5173/",
        host: "127.0.0.1",
        port: 5173,
        source: "detail",
      },
    ]);
  });

  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
  });

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });

  it("keeps command presentation stable", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: { command: "bun run lint" },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({ summary: "Ran command", detail: "bun run lint" });
  });
});
