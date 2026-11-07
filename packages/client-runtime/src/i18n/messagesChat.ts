/**
 * Chat settings panel: composer and follow-ups.
 * Add the English key first, then its zh-Hans entry — English is the source of truth.
 */
export const enMessages = {
  "settings.chat.composer.title": "Composer",
  "settings.chat.richText.title": "Rich text composer",
  "settings.chat.richText.description": "Show formatted Markdown as you type.",
  "settings.chat.richText.resetLabel": "rich text composer",
  "settings.chat.richText.a11y": "Rich text composer",
  "settings.chat.sendShortcut.title": "Send shortcut",
  "settings.chat.sendShortcut.description":
    "Choose when Enter sends a prompt or inserts a new line",
  "settings.chat.sendShortcut.resetLabel": "send shortcut",
  "settings.chat.sendShortcut.a11y": "Send shortcut",
  "settings.chat.sendShortcut.enter": "Enter",
  "settings.chat.sendShortcut.modEnterMultiline": "{mod} + Enter for multiline prompts",
  "settings.chat.sendShortcut.modEnter": "{mod} + Enter always",
  "settings.chat.skillsInSlashMenu.title": "Show skills in slash menu",
  "settings.chat.skillsInSlashMenu.description":
    "Also include skills in the / command menu. Skills always appear when you type $.",
  "settings.chat.skillsInSlashMenu.resetLabel": "skills in slash menu",
  "settings.chat.skillsInSlashMenu.a11y": "Show skills in slash menu",
  "settings.chat.followUps.title": "Follow-ups",
  "settings.chat.followUpBehavior.title": "Follow-up behavior",
  "settings.chat.followUpBehavior.description":
    "Queue follow-ups while the agent runs or steer the current run. {opposite}",
  "settings.chat.followUpBehavior.oppositeMultiline":
    "Press {mod} + Enter for single-line prompts or {mod} + Shift + Enter for multiline prompts to do the opposite for one message.",
  "settings.chat.followUpBehavior.opposite":
    "Press {shortcut} + Enter to do the opposite for one message.",
  "settings.chat.followUpBehavior.resetLabel": "follow-up behavior",
  "settings.chat.followUpBehavior.a11y": "Follow-up behavior",
  "settings.chat.followUpBehavior.queue": "Queue",
  "settings.chat.followUpBehavior.steer": "Steer",
} as const;

export const zhHansMessages: Partial<Record<keyof typeof enMessages, string>> = {
  "settings.chat.composer.title": "输入框",
  "settings.chat.richText.title": "富文本输入框",
  "settings.chat.richText.description": "边输入边显示排好版的 Markdown。",
  "settings.chat.richText.resetLabel": "富文本输入框",
  "settings.chat.richText.a11y": "富文本输入框",
  "settings.chat.sendShortcut.title": "发送快捷键",
  "settings.chat.sendShortcut.description": "选择按 Enter 时是发送提示词，还是换行",
  "settings.chat.sendShortcut.resetLabel": "发送快捷键",
  "settings.chat.sendShortcut.a11y": "发送快捷键",
  "settings.chat.sendShortcut.enter": "Enter",
  "settings.chat.sendShortcut.modEnterMultiline": "多行提示词时用 {mod} + Enter",
  "settings.chat.sendShortcut.modEnter": "始终用 {mod} + Enter",
  "settings.chat.skillsInSlashMenu.title": "在 / 菜单里显示技能",
  "settings.chat.skillsInSlashMenu.description":
    "在 / 命令菜单里也列出技能。输入 $ 时总会显示技能。",
  "settings.chat.skillsInSlashMenu.resetLabel": "/ 菜单里的技能",
  "settings.chat.skillsInSlashMenu.a11y": "在 / 菜单里显示技能",
  "settings.chat.followUps.title": "追加消息",
  "settings.chat.followUpBehavior.title": "追加消息方式",
  "settings.chat.followUpBehavior.description":
    "智能体运行时，追加的消息可以排队等待，也可以直接引导当前这一轮。{opposite}",
  "settings.chat.followUpBehavior.oppositeMultiline":
    "单行提示词按 {mod} + Enter，多行提示词按 {mod} + Shift + Enter，这一条就用另一种方式。",
  "settings.chat.followUpBehavior.opposite": "按 {shortcut} + Enter，这一条就用另一种方式。",
  "settings.chat.followUpBehavior.resetLabel": "追加消息方式",
  "settings.chat.followUpBehavior.a11y": "追加消息方式",
  "settings.chat.followUpBehavior.queue": "排队",
  "settings.chat.followUpBehavior.steer": "引导",
};
