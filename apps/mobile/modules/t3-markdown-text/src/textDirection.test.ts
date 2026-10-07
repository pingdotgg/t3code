import { expect, it } from "vite-plus/test";
import { markdownTextDirection } from "./textDirection";

it("takes the direction of the first letter, skipping markers, digits and punctuation", () => {
  expect(markdownTextDirection("مرحبا بالعالم")).toBe("rtl");
  expect(markdownTextDirection("שלום עולם")).toBe("rtl");
  expect(markdownTextDirection("1. «مرحبا» then English")).toBe("rtl");
  expect(markdownTextDirection("• Run `bun test` قبل الدمج")).toBe("ltr");
  expect(markdownTextDirection("١٢٣ — Hello")).toBe("ltr");
});

it("leaves text without letters to the direction it inherits", () => {
  expect(markdownTextDirection("")).toBeNull();
  expect(markdownTextDirection("123 — 456 ✓")).toBeNull();
});
