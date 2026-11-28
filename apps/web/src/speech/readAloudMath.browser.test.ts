import { readAloudText } from "@t3tools/shared/read-aloud";
import { expect, it, vi } from "vite-plus/test";

const settings = vi.hoisted(() => ({ mathRenderingEnabled: true }));
vi.mock("../hooks/useSettings", () => ({ getClientSettings: () => settings }));

import { prepareReadAloudMath } from "./readAloudMath";

it("reads rendered formulas the way screen readers say them, and TeX when math shows as text", async () => {
  const markdown =
    "The loss is $x^2 + y^2$ over $n$ samples.\n\n$$\n\\frac{a}{b}\n$$\n\nPrices stay $5 and $10.";
  const speakMath = await prepareReadAloudMath(markdown);
  expect(readAloudText(markdown, true, { math: speakMath })).toBe(
    "The loss is x squared plus y squared over n samples.\na over b.\nPrices stay $5 and $10.",
  );

  settings.mathRenderingEnabled = false;
  expect(await prepareReadAloudMath(markdown)).toBeUndefined();
  expect(readAloudText(markdown, true)).toContain("$x^2 + y^2$");
});
