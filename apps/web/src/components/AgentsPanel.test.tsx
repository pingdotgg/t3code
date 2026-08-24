import { emptyAgentPanelModel } from "@t3tools/client-runtime/state/subagentRuntime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { I18nProvider } from "../i18n";
import { AgentsPanel } from "./AgentsPanel";

describe("AgentsPanel", () => {
  it("renders the Simplified Chinese empty state", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="zh-CN">
        <AgentsPanel model={emptyAgentPanelModel()} />
      </I18nProvider>,
    );

    expect(markup).toContain("暂无 Agent");
    expect(markup).toContain("实时状态、活动和 Token 用量");
  });
});
