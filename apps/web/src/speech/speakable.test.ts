import { expect, it } from "vite-plus/test";

import { toSpeakableSentences } from "./speakable";

const spoken = (text: string) => toSpeakableSentences(text).join(" ");

it("reads decimal points without changing sentence periods", () => {
  expect(spoken("It used 14.5% after falling from 1,234.05 to -0.4.")).toBe(
    "It used fourteen point five percent after falling from one thousand two hundred thirty four point zero five to minus zero point four.",
  );
});

it("drops emoji so markers like the speaker icon are not read aloud", () => {
  expect(spoken("🔊 The check is quick ✅ and 🎙️ done.")).toBe("The check is quick and done.");
});

it("reads decimal money as dollars and cents", () => {
  expect(spoken("It cost $14.50, then $0.05, and the refund was -$1.01.")).toBe(
    "It cost fourteen dollars and fifty cents, then five cents, and the refund was minus one dollar and one cent.",
  );
  expect(spoken("$0.00 $-1.000 $2.00 -.5%")).toBe(
    "zero dollars minus one point zero zero zero dollars two dollars minus zero point five percent",
  );
});

it("leaves version numbers and addresses unchanged", () => {
  expect(spoken("Version 0.10.3, address 127.0.0.1, and value 1.2e3 stay unchanged.")).toBe(
    "Version 0.10.3, address 127.0.0.1, and value 1.2e3 stay unchanged.",
  );
});

it("reads large numbers by scale and very large ones digit by digit", () => {
  expect(spoken("1000000.0 100.0 20.0")).toBe(
    "one million point zero one hundred point zero twenty point zero",
  );
  expect(spoken("1000000000000000000.0")).toBe(
    "one zero zero zero zero zero zero zero zero zero zero zero zero zero zero zero zero zero zero point zero",
  );
});

it("removes markdown presentation while keeping useful words", () => {
  expect(
    spoken(
      "# Heading\n- **bold** `code` [label](https://example.com) ![image](x) https://example.com\n```ts\ncode\n```",
    ),
  ).toBe("Heading bold code label (link) (code omitted)");
});

it("splits a reply into sentences and long sentences on word boundaries", () => {
  expect(toSpeakableSentences("First one. Second one? Third!")).toEqual([
    "First one.",
    "Second one?",
    "Third!",
  ]);
  const long = toSpeakableSentences(`word ${"repeat ".repeat(300)}end.`);
  expect(long.length).toBeGreaterThan(1);
  for (const piece of long) expect(piece.length).toBeLessThanOrEqual(700);
  expect(toSpeakableSentences("x".repeat(1400))).toEqual(["x".repeat(700), "x".repeat(700)]);
  expect(toSpeakableSentences("   ")).toEqual([]);
});
