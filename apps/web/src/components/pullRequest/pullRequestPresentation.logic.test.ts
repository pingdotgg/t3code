import { beforeEach, describe, expect, it } from "vite-plus/test";

import { i18n } from "../../i18nCore";
import { presentationLabel } from "./pullRequestPresentation";

describe("presentationLabel", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("translates catalog keys", async () => {
    expect(presentationLabel("state.open")).toBe("Open");
    await i18n.changeLanguage("zh-Hans");
    expect(presentationLabel("state.open")).toBe("打开");
  });

  it("does not add the namespace twice to an already-namespaced key", () => {
    expect(presentationLabel("pullRequest:checksState.passing")).toBe("All checks have passed");
  });

  it("passes already-resolved strings through without the namespace prefix", async () => {
    await i18n.changeLanguage("zh-Hans");
    expect(presentationLabel("与 main 存在冲突")).toBe("与 main 存在冲突");
    expect(presentationLabel("Sort pull requests")).toBe("Sort pull requests");
    await i18n.changeLanguage("en");
    expect(presentationLabel("Sort pull requests")).toBe("Sort pull requests");
  });
});
