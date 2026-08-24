import { describe, expect, it } from "vite-plus/test";

import { createTranslator, translate } from "./messages";

describe("translated messages", () => {
  it("returns the message for the requested locale", () => {
    expect(translate("en", "common.cancel")).toBe("Cancel");
    expect(translate("zh-CN", "common.cancel")).toBe("取消");
  });

  it("interpolates dynamic values as text", () => {
    expect(translate("zh-CN", "common.files", { count: 2 })).toBe("2 个文件");
  });

  it("creates a translator bound to one locale", () => {
    const t = createTranslator("zh-CN");

    expect(t("common.save")).toBe("保存");
  });

  it("covers the remaining desktop product surfaces", () => {
    const t = createTranslator("zh-CN");

    expect(t("providers.title")).toBe("供应商");
    expect(t("git.commit")).toBe("提交");
    expect(t("terminal.title")).toBe("终端");
    expect(t("preview.refresh")).toBe("刷新");
    expect(t("auth.signIn")).toBe("登录");
    expect(t("connections.title")).toBe("连接");
  });

  it("covers desktop accessibility and contextual action copy", () => {
    const t = createTranslator("zh-CN");

    expect(t("common.close")).toBe("关闭");
    expect(t("common.loading")).toBe("正在加载");
    expect(t("common.remove")).toBe("移除");
    expect(t("common.dismissNotification")).toBe("关闭通知");
    expect(t("sidebar.toggle")).toBe("切换主侧栏");
    expect(t("sidebar.resize")).toBe("调整侧栏宽度");
    expect(t("sidebar.dragToResize")).toBe("拖动以调整侧栏宽度");
    expect(t("chat.scrollToEnd")).toBe("滚动到底部");
    expect(t("chat.image.expandedPreview")).toBe("展开的图片预览");
    expect(t("chat.model.search")).toBe("搜索模型…");
    expect(t("chat.model.new")).toBe("新模型");
    expect(t("chat.panel.toggleTerminal")).toBe("切换终端抽屉");
    expect(t("chat.panel.toggleRight")).toBe("切换右侧面板");
    expect(t("chat.error.dismiss")).toBe("关闭错误提示");
    expect(t("chat.preview.removeAnnotation")).toBe("移除预览标注");
    expect(t("chat.task.toggle")).toBe("切换任务状态");
    expect(t("chat.openIntegratedBrowser")).toBe("在内置浏览器中打开");
    expect(t("chat.openSystemBrowser")).toBe("在系统浏览器中打开");
  });

  it("localizes chat timeline activity and changed-file controls", () => {
    const t = createTranslator("zh-CN");

    expect(t("chat.timeline.workingFor", { duration: "6s" })).toBe("已工作 6s");
    expect(t("chat.timeline.previousToolCalls", { count: 3 })).toBe("+3 次之前的工具调用");
    expect(t("chat.timeline.showFewerToolCalls")).toBe("收起工具调用");
    expect(t("chat.changedFiles.heading", { count: 54 })).toBe("已更改文件（54）");
    expect(t("chat.changedFiles.expandAll")).toBe("全部展开");
    expect(t("chat.changedFiles.viewDiff")).toBe("查看差异");
  });

  it("localizes provider update notifications", () => {
    const t = createTranslator("zh-CN");

    expect(t("providerUpdate.running.title")).toBe("正在更新提供商");
    expect(t("providerUpdate.running.description")).toBe("正在运行提供商更新命令。");
    expect(t("providerUpdate.action.update")).toBe("更新");
    expect(t("providerUpdate.action.settings")).toBe("设置");
  });

  it("localizes the native agents and skills surfaces", () => {
    const t = createTranslator("zh-CN");

    expect(t("agents.empty.title")).toBe("暂无 Agent");
    expect(t("agents.phase.activeDone", { active: 2, done: 3 })).toBe("执行中 2 · 已完成 3");
    expect(t("chat.skills.empty")).toBe("未找到技能。可输入 / 浏览供应商命令。");
    expect(t("chat.skills.source.repo")).toBe("仓库");
    expect(t("settings.skillsMenu.title")).toBe("在斜杠命令菜单中显示技能");
  });
});
