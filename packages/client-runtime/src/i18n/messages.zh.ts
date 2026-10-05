/**
 * Simplified Chinese catalog.
 *
 * Partial on purpose: a missing key falls back to `en` per key, so an
 * untranslated surface reads as English rather than as a raw key. Only the
 * welcome wizard is translated so far.
 *
 * Chinese has one plural form, so counts only need `_other`; i18next uses it
 * for every count when there is no `_one` form.
 *
 * Product names (Codex, Claude Code, T3 Connect, ChatGPT) and shell commands
 * are not translated. Terms follow the glossary: a *thread* is 会话, not 线程,
 * which would read as an operating-system thread.
 */
import type { Messages } from "./messages.en.ts";

export const zh: Partial<Messages> = {
  // Shared across steps.
  "wizard.continue": "继续",
  "wizard.retry": "重试",
  "wizard.close": "关闭",
  "wizard.run": "运行",
  "wizard.install": "安装",
  "wizard.signIn": "登录",
  "wizard.ready": "就绪",
  "wizard.checking": "检查中…",
  "wizard.disabled": "已停用",
  "wizard.computer": "电脑",

  // Steps.
  "wizard.step.connect": "连接",
  "wizard.step.agents": "智能体",
  "wizard.step.projects": "项目",

  // Connection step.
  "wizard.connection.title": "连接你的电脑",
  "wizard.connection.description": "选择一台或多台电脑，我们会分别在每台上配置智能体和项目。",
  "wizard.connection.computersToSetUp": "待配置的电脑",
  "wizard.connection.addComputer": "添加电脑",
  "wizard.connection.loadingComputers": "正在加载电脑…",
  "wizard.connection.loadingSignIn": "正在加载登录…",
  "wizard.connection.noComputersLinked": "尚未连接任何电脑。",
  "wizard.connection.runOnEachComputer": "在每台要连接的电脑上运行此命令。",
  "wizard.connection.keepRunning": "请保持 T3 Code 运行，并在上方选择要配置的电脑。",
  "wizard.connection.pairingLink": "配对链接",
  "wizard.connection.needPairingLink": "需要配对链接？",
  "wizard.connection.runOnCodeComputer": "在存放你代码的电脑上运行此命令。",
  "wizard.connection.startFirstOrRun": "请先启动 T3 Code，或运行 ",
  "wizard.connection.addTailscale_before": "，再加上 ",
  "wizard.connection.tailnetSuffix": " 即可使用你的 tailnet。",
  "wizard.connection.pair": "配对",
  "wizard.connection.pairing": "配对中…",
  "wizard.connection.pairingFailed": "配对失败。",
  "wizard.connection.connected": "已连接",
  "wizard.connection.connecting": "连接中…",
  "wizard.connection.connectAnotherChatGpt": "连接其他 ChatGPT 账号",

  // Agents step.
  "wizard.header.title": "设置 T3 Code",
  "wizard.agents.connectTitle": "连接你的智能体",
  "wizard.agents.connectDescription": "选择要开始使用的编程智能体，之后还可以再添加。",
  "wizard.agents.readyToCode": "可以开始编程了。",
  "wizard.agents.reviewCommand": "确认命令后按回车运行。",
  "wizard.agents.couldNotOpenTerminal": "无法打开设置终端。",
  "wizard.agents.preparingCommand": "正在准备命令…",
  "wizard.runInTerminal_before": "请在终端中运行 ",
  "wizard.runInTerminal_after": "",
  "wizard.agents.terminalLabel": "安装 {{driver}}",
  "wizard.agents.copyCommand": "复制命令",

  // Projects step.
  "wizard.projects.title": "你的项目",
  "wizard.projects.chooseTitle": "选择你的项目",
  "wizard.projects.chooseDescription": "从所选电脑导入项目和会话记录。",
  "wizard.projects.lookingForProjects": "正在查找项目…",
  "wizard.projects.lookingForImported": "正在查找来自 Claude Code 和 Codex 的项目…",
  "wizard.projects.noneFound": "未找到现有的 Claude Code 或 Codex 项目。",
  "wizard.projects.couldNotCheck": "无法检查项目。{{error}}",
  "wizard.projects.doNotImport": "不导入项目",
  "wizard.projects.selectAll": "全选",
  "wizard.projects.selectNone": "全不选",
  "wizard.projects.otherFolders": "其他文件夹",
  "wizard.projects.importing": "正在导入…",
  "wizard.projects.folderCount_other": "{{count}} 个文件夹",
  "wizard.projects.selectedCount": "已选 {{selected}} / {{total}} 项",
  "wizard.projects.importCount_other": "导入 {{count}} 个项目",
  "wizard.projects.scanLimitReached": "已达扫描上限，部分项目或会话可能未显示。",

  // Import results.
  "wizard.import.imported_other": "已导入 {{count}} 条会话",
  "wizard.import.skipped_other": "有 {{count}} 条会话无法导入。",
  "wizard.import.importedWithRemaining_other": "已导入 {{count}} 条会话。部分会话记录无法导入。",
  "wizard.import.couldNotImport": "无法导入会话记录。",
  "wizard.import.someHistoryNotImported": "部分记录未导入",
  // Chinese joins sentences with its own full stop and no trailing space.
  "wizard.import.sentenceSeparator": "。",

  // Completion.
  "wizard.completion.couldNotFinish": "无法完成设置",
  "wizard.completion.settingsNotSaved": "无法保存你的设置，请重试。",

  // Settings row for choosing the interface language.
  "settings.language.title": "语言",
  "settings.language.description": "“跟随系统”会使用浏览器或操作系统的语言设置。",
  "settings.language.system": "跟随系统",
};
