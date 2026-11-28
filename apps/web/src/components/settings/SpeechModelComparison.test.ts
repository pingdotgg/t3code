import { expect, it } from "vite-plus/test";

import { orderSpeechLanguages } from "./SpeechModelComparison";

it("sorts non-common languages using the requested UI locale", () => {
  expect(orderSpeechLanguages(["fo", "fil", "fi"], [], "sv")).toEqual(["fil", "fi", "fo"]);
  expect(orderSpeechLanguages(["sv", "fi"], [], "zh")).toEqual(["fi", "sv"]);
});
