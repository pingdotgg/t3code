/**
 * Shared agent terms: permission (runtime) modes and where a new thread starts.
 * Settings reads them today; the chat composer can adopt the same keys.
 * Add the English key first, then its zh-Hans entry — English is the source of truth.
 */
export const enMessages = {
  "runtimeMode.approvalRequired.label": "Supervised",
  "runtimeMode.approvalRequired.description": "Ask before commands and file changes.",
  "runtimeMode.autoAcceptEdits.label": "Auto-accept edits",
  "runtimeMode.autoAcceptEdits.description": "Auto-approve edits, ask before other actions.",
  "runtimeMode.auto.label": "Auto",
  "runtimeMode.auto.description": "Supported providers approve routine actions; others still ask.",
  "runtimeMode.fullAccess.label": "Full access",
  "runtimeMode.fullAccess.description": "Allow commands and edits without prompts.",
  "envMode.local": "Current checkout",
  "envMode.worktree": "New worktree",
} as const;

export const zhHansMessages: Partial<Record<keyof typeof enMessages, string>> = {
  "runtimeMode.approvalRequired.label": "需要批准",
  "runtimeMode.approvalRequired.description": "执行命令和改文件之前先询问。",
  "runtimeMode.autoAcceptEdits.label": "自动接受编辑",
  "runtimeMode.autoAcceptEdits.description": "改文件自动批准，其他操作之前先询问。",
  "runtimeMode.auto.label": "自动",
  "runtimeMode.auto.description": "支持的提供商会自动批准常规操作，其他的仍会询问。",
  "runtimeMode.fullAccess.label": "完全访问",
  "runtimeMode.fullAccess.description": "执行命令和改文件都不再询问。",
  "envMode.local": "当前检出",
  "envMode.worktree": "新工作树",
};
