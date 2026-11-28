import { expect, it } from "vite-plus/test";
import { prepareReadAloudEmoji } from "./readAloudEmoji.ts";

it("names emoji by their CLDR short names, ignoring skin tones and presentation", async () => {
  expect(prepareReadAloudEmoji("No emoji here.")).toBeUndefined();
  const name = await prepareReadAloudEmoji("👍")!;
  expect(["🎉", "👍🏽", "❤️", "✅", "🇺🇸", "👨‍💻"].map(name)).toEqual([
    "party popper",
    "thumbs up",
    "red heart",
    "check mark button",
    "flag united states",
    "man technologist",
  ]);
});
