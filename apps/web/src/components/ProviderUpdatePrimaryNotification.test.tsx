import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { createTranslator, I18nProvider, I18nText } from "../i18n";
import {
  getProviderUpdateRunningToastView,
  resolveProviderUpdateToastText,
} from "./ProviderUpdateLaunchNotification.logic";
import { getProviderUpdateToastUpdate } from "./ProviderUpdatePrimaryNotification";

describe("getProviderUpdateToastUpdate", () => {
  it("clears the prompt action when the toast enters the loading state", () => {
    const update = getProviderUpdateToastUpdate({
      view: getProviderUpdateRunningToastView(1, createTranslator("zh-CN")),
      openSettings: () => undefined,
    });

    expect(Object.hasOwn(update, "actionProps")).toBe(true);
    expect(update.actionProps).toEqual({ children: null });
    expect(update.type).toBe("loading");
  });

  it("renders a previously created toast with the active locale", () => {
    const view = getProviderUpdateRunningToastView(1, createTranslator("en"));
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="zh-CN">
        <I18nText>{(t) => resolveProviderUpdateToastText(view, t).title}</I18nText>
      </I18nProvider>,
    );

    expect(markup).toContain("正在更新提供商");
    expect(markup).not.toContain("Updating provider");
  });
});
