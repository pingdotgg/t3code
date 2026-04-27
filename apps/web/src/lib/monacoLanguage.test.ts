import { describe, expect, it } from "vitest";
import { resolveMonacoLanguage } from "./monacoLanguage";

describe("resolveMonacoLanguage", () => {
  it("maps TSX files to the TypeScript Monaco language", () => {
    expect(resolveMonacoLanguage("src/components/ChatView.tsx")).toBe("typescript");
  });

  it("maps JSX files to the JavaScript Monaco language", () => {
    expect(resolveMonacoLanguage("src/components/App.jsx")).toBe("javascript");
  });

  it("maps known non-TS text formats", () => {
    expect(resolveMonacoLanguage("src/index.css")).toBe("css");
    expect(resolveMonacoLanguage("src/index.html")).toBe("html");
    expect(resolveMonacoLanguage("package.json")).toBe("json");
  });

  it("returns undefined for files without a known extension mapping", () => {
    expect(resolveMonacoLanguage("Dockerfile")).toBeUndefined();
    expect(resolveMonacoLanguage("README.unknown")).toBeUndefined();
  });
});
