import { expect, it, vi } from "vite-plus/test";

import { flattenStyles } from "./util";

vi.mock("react-native", () => ({
  I18nManager: { isRTL: false },
  StyleSheet: {
    flatten: (styles: ReadonlyArray<object | undefined>) => Object.assign({}, ...styles),
  },
}));

it("encodes numeric bold weights as bold source-text runs", () => {
  expect(flattenStyles({ fontWeight: 700 }, undefined).fontWeight).toBe("bold");
  expect(flattenStyles({ fontWeight: "400" }, { fontWeight: "700" }).fontWeight).toBe("bold");
});
