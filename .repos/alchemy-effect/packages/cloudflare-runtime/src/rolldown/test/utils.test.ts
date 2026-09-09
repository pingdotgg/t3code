import { describe, expect, it } from "vitest";
import { hasNodejsCompat, sanitizePath } from "../utils.ts";

describe("utils", () => {
  describe("sanitizePath", () => {
    it("strips query strings", () => {
      expect(sanitizePath("/tmp/example.wasm?init")).toBe("/tmp/example.wasm");
      expect(sanitizePath("/tmp/example.wasm?module")).toBe(
        "/tmp/example.wasm",
      );
    });

    it("strips hashes", () => {
      expect(sanitizePath("/tmp/example.wasm#fragment")).toBe(
        "/tmp/example.wasm",
      );
      expect(sanitizePath("/tmp/example.wasm?init#fragment")).toBe(
        "/tmp/example.wasm",
      );
    });
  });

  describe("hasNodejsCompat", () => {
    it("detects nodejs_compat", () => {
      expect(hasNodejsCompat(["nodejs_compat"])).toBe(true);
    });

    it("detects nodejs_compat_v2", () => {
      expect(hasNodejsCompat(["nodejs_compat_v2"])).toBe(true);
    });

    it("returns false without compatibility flags", () => {
      expect(hasNodejsCompat()).toBe(false);
      expect(hasNodejsCompat(["durable_object_alarms"])).toBe(false);
    });
  });
});
