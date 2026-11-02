/**
 * Diffs & pull requests settings panel.
 * Add the English key first, then its zh-Hans entry — English is the source of truth.
 */
export const enMessages = {
  "settings.diffs.title": "Diffs",
  "settings.diffs.layout.title": "Diff layout",
  "settings.diffs.layout.description":
    "Show diffs stacked or side by side. The toggle in the diff toolbar changes this too.",
  "settings.diffs.layout.resetLabel": "diff layout",
  "settings.diffs.layout.a11y": "Diff layout",
  "settings.diffs.layout.stacked": "Stacked",
  "settings.diffs.layout.split": "Split",
  "settings.diffs.whitespace.title": "Hide whitespace changes",
  "settings.diffs.whitespace.description":
    "Set whether the diff panel ignores whitespace-only edits by default.",
  "settings.diffs.whitespace.resetLabel": "diff whitespace changes",
  "settings.diffs.whitespace.a11y": "Hide whitespace changes by default",
  "settings.diffs.fileState.title": "Default diff file state",
  "settings.diffs.fileState.description":
    "Start with files expanded or collapsed when opening diffs or a pull request's Code tab.",
  "settings.diffs.fileState.resetLabel": "default diff file state",
  "settings.diffs.fileState.a11y": "Default diff file state",
  "settings.diffs.fileState.expanded": "Expanded",
  "settings.diffs.fileState.collapsed": "Collapsed",
  "settings.diffs.colors.title": "Diff colors",
  "settings.diffs.colors.description":
    "Choose colors for additions and deletions, including change counts.",
  "settings.diffs.colors.resetLabel": "diff colors",
  "settings.diffs.colors.a11y": "Diff colors",
  "settings.diffs.colors.redGreen": "Red & green",
  "settings.diffs.colors.redGreenDefault": "Red & green (default)",
  "settings.diffs.colors.blueOrange": "Blue & orange",
  "settings.diffs.pullRequests.title": "Pull requests",
  "settings.diffs.proactivePanels.title": "Open pull requests and changes panels proactively",
  "settings.diffs.proactivePanels.description":
    "Open linked pull requests first. Otherwise, open Changes for edits to at least 3 files or 50 lines.",
  "settings.diffs.proactivePanels.resetLabel": "proactive panels",
  "settings.diffs.proactivePanels.a11y": "Open pull requests and changes panels proactively",
  "settings.diffs.prLinksInApp.title": "Open pull requests in T3 Code",
  "settings.diffs.prLinksInApp.description":
    "Clicking a pull request link opens it in T3 Code. Turn off to open pull request links like any other link, on your git host.",
  "settings.diffs.prLinksInApp.resetLabel": "open pull requests in T3 Code",
  "settings.diffs.prLinksInApp.a11y": "Open pull requests in T3 Code",
} as const;

export const zhHansMessages: Partial<Record<keyof typeof enMessages, string>> = {
  "settings.diffs.title": "差异",
  "settings.diffs.layout.title": "差异布局",
  "settings.diffs.layout.description":
    "上下堆叠或左右并排显示差异。差异工具栏里的切换按钮也会改这一项。",
  "settings.diffs.layout.resetLabel": "差异布局",
  "settings.diffs.layout.a11y": "差异布局",
  "settings.diffs.layout.stacked": "上下堆叠",
  "settings.diffs.layout.split": "左右并排",
  "settings.diffs.whitespace.title": "隐藏空白改动",
  "settings.diffs.whitespace.description": "差异面板默认是否忽略只改了空白的地方。",
  "settings.diffs.whitespace.resetLabel": "差异里的空白改动",
  "settings.diffs.whitespace.a11y": "默认隐藏空白改动",
  "settings.diffs.fileState.title": "文件默认展开状态",
  "settings.diffs.fileState.description":
    "打开差异，或打开 Pull Request 的「代码」标签页时，文件默认展开还是折叠。",
  "settings.diffs.fileState.resetLabel": "文件默认展开状态",
  "settings.diffs.fileState.a11y": "文件默认展开状态",
  "settings.diffs.fileState.expanded": "展开",
  "settings.diffs.fileState.collapsed": "折叠",
  "settings.diffs.colors.title": "差异颜色",
  "settings.diffs.colors.description": "选择新增和删除用的颜色，改动计数也用这套颜色。",
  "settings.diffs.colors.resetLabel": "差异颜色",
  "settings.diffs.colors.a11y": "差异颜色",
  "settings.diffs.colors.redGreen": "红与绿",
  "settings.diffs.colors.redGreenDefault": "红与绿（默认）",
  "settings.diffs.colors.blueOrange": "蓝与橙",
  "settings.diffs.pullRequests.title": "Pull Request",
  "settings.diffs.proactivePanels.title": "自动打开 Pull Request 和改动面板",
  "settings.diffs.proactivePanels.description":
    "有关联的 Pull Request 就先打开它；没有的话，改动至少 3 个文件或 50 行时打开「改动」面板。",
  "settings.diffs.proactivePanels.resetLabel": "自动打开面板",
  "settings.diffs.proactivePanels.a11y": "自动打开 Pull Request 和改动面板",
  "settings.diffs.prLinksInApp.title": "在 T3 Code 里打开 Pull Request",
  "settings.diffs.prLinksInApp.description":
    "点击 Pull Request 链接时在 T3 Code 里打开。关掉后，它和其他链接一样，在你的 Git 托管网站上打开。",
  "settings.diffs.prLinksInApp.resetLabel": "在 T3 Code 里打开 Pull Request",
  "settings.diffs.prLinksInApp.a11y": "在 T3 Code 里打开 Pull Request",
};
