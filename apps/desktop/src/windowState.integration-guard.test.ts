import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const MAIN_TS_PATH = path.resolve(__dirname, "main.ts");

describe("window position persistence regression guard", () => {
  const mainSource = fs.readFileSync(MAIN_TS_PATH, "utf8");

  it("main.ts imports readWindowState from windowState module", () => {
    expect(mainSource).toMatch(
      /import\s+.*readWindowState.*from\s+["']\.\/windowState(?:\.ts)?["']/,
    );
  });

  it("main.ts imports writeWindowState from windowState module", () => {
    expect(mainSource).toMatch(
      /import\s+.*writeWindowState.*from\s+["']\.\/windowState(?:\.ts)?["']/,
    );
  });

  it("main.ts imports resolveWindowBounds from windowState module", () => {
    expect(mainSource).toMatch(
      /import\s+.*resolveWindowBounds.*from\s+["']\.\/windowState(?:\.ts)?["']/,
    );
  });

  it("main.ts defines WINDOW_STATE_PATH constant", () => {
    expect(mainSource).toContain("WINDOW_STATE_PATH");
  });

  it("main.ts reads window state at startup", () => {
    expect(mainSource).toMatch(/readWindowState\s*\(\s*WINDOW_STATE_PATH\s*\)/);
  });

  it("main.ts uses resolveWindowBounds in createWindow", () => {
    expect(mainSource).toContain("resolveWindowBounds(lastWindowState)");
  });

  it("main.ts saves window state on before-quit", () => {
    const beforeQuitBlock = mainSource.slice(
      mainSource.indexOf("before-quit"),
      mainSource.indexOf("before-quit") + 500,
    );
    expect(beforeQuitBlock).toContain("saveWindowState");
  });

  it("main.ts attaches move and resize listeners for window state persistence", () => {
    expect(mainSource).toMatch(/window\.on\s*\(\s*["']resize["']/);
    expect(mainSource).toMatch(/window\.on\s*\(\s*["']move["']/);
  });
});
