import { describe, expect, it } from "vite-plus/test";

import { createTranslator } from "./messages";
import { localizedSourceControlDiscoveryText } from "./sourceControl";

describe("localizedSourceControlDiscoveryText", () => {
  const t = createTranslator("zh-CN");

  it("localizes known discovery install hints", () => {
    expect(
      localizedSourceControlDiscoveryText(
        "Install Git from https://git-scm.com/downloads or with your package manager.",
        t,
      ),
    ).toBe("从 https://git-scm.com/downloads 下载 Git，或使用软件包管理器安装。");
  });

  it("localizes known authentication fallback details", () => {
    expect(
      localizedSourceControlDiscoveryText("Run `gh auth login` to authenticate GitHub CLI.", t),
    ).toBe("运行 `gh auth login` 认证 GitHub CLI。");
    expect(localizedSourceControlDiscoveryText("Bitbucket API token is configured.", t)).toBe(
      "已配置 Bitbucket API 令牌。",
    );
  });

  it("preserves provider output and future diagnostics verbatim", () => {
    const diagnostic = "github.example.com: custom SSO policy rejected this account";
    expect(localizedSourceControlDiscoveryText(diagnostic, t)).toBe(diagnostic);
    expect(localizedSourceControlDiscoveryText("toString", t)).toBe("toString");
  });
});
