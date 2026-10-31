/**
 * Typography settings panel (fonts, sizes, smoothing, word wrap) and the
 * thread details row. Extracted by the typography extraction work; add the
 * English key first, then its zh-Hans entry — English is the source of truth.
 */
export const enMessages = {
  "settings.typography.title": "Typography",
  "settings.typography.systemDefault": "System default",
  "settings.typography.systemMonospace": "System monospace",
  "settings.typography.interfaceFont.title": "Interface font",
  "settings.typography.interfaceFont.description":
    "Everything outside code blocks and the terminal.",
  "settings.typography.interfaceFont.sizeLabel": "Interface font size",
  "settings.typography.interfaceFont.familyA11y": "Interface font family",
  "settings.typography.promptFont.title": "Prompt font",
  "settings.typography.promptFont.description":
    "Only the box you write prompts in. Mono works well here.",
  "settings.typography.promptFont.sizeLabel": "Prompt font size",
  "settings.typography.promptFont.familyA11y": "Prompt font family",
  "settings.typography.codeFont.title": "Code font",
  "settings.typography.codeFont.description": "Code blocks, diffs, and file previews.",
  "settings.typography.codeFont.sizeLabel": "Code font size",
  "settings.typography.codeFont.familyA11y": "Code font family",
  "settings.typography.monospaceFont.title": "Monospace font",
  "settings.typography.monospaceFont.description":
    "Code blocks, diffs, file previews, and the terminal.",
  "settings.typography.monospaceFont.familyA11y": "Monospace font family",
  "settings.typography.terminalFont.title": "Terminal font",
  "settings.typography.terminalFont.description":
    "Terminal output, independent from code blocks and diffs.",
  "settings.typography.terminalFont.sizeLabel": "Terminal font size",
  "settings.typography.terminalFont.familyA11y": "Terminal font family",
  "settings.typography.separateFonts.title": "Separate fonts",
  "settings.typography.separateFonts.description":
    "Set the prompt, code, and terminal fonts separately instead of one monospace font.",
  "settings.typography.separateFonts.a11y": "Separate fonts",
  "settings.typography.fontSmoothing.title": "Font smoothing",
  "settings.typography.fontSmoothing.description":
    "Use thinner grayscale text smoothing instead of the macOS default.",
  "settings.typography.fontSmoothing.a11y": "Font smoothing",
  "settings.typography.fontSmoothing.resetLabel": "font smoothing",
  "settings.typography.wordWrap.title": "Word wrap",
  "settings.typography.wordWrap.description":
    "Wrap long lines in code blocks, diffs, and file previews by default.",
  "settings.typography.wordWrap.a11y": "Wrap code, diffs, and file previews by default",
  "settings.typography.wordWrap.resetLabel": "word wrapping",
  "settings.threadDetails.title": "Thread details",
  "settings.threadDetails.resetLabel": "thread details",
  "settings.threadDetails.description":
    "Choose what the thread details card shows. You can also right-click the card.",
  "settings.threadDetails.summary": "{enabled} of {total} on",
  "settings.threadDetails.summaryA11y": "Thread details: {enabled} of {total} on",
} as const;

export const zhHansMessages: Partial<Record<keyof typeof enMessages, string>> = {
  "settings.typography.title": "字体排印",
  "settings.typography.systemDefault": "系统默认",
  "settings.typography.systemMonospace": "系统等宽字体",
  "settings.typography.interfaceFont.title": "界面字体",
  "settings.typography.interfaceFont.description": "代码块与终端之外的所有界面。",
  "settings.typography.interfaceFont.sizeLabel": "界面字体大小",
  "settings.typography.interfaceFont.familyA11y": "界面字体",
  "settings.typography.promptFont.title": "输入框字体",
  "settings.typography.promptFont.description":
    "仅作用于书写提示词的文本框，等宽字体在这里效果很好。",
  "settings.typography.promptFont.sizeLabel": "输入框字体大小",
  "settings.typography.promptFont.familyA11y": "输入框字体",
  "settings.typography.codeFont.title": "代码字体",
  "settings.typography.codeFont.description": "代码块、差异与文件预览。",
  "settings.typography.codeFont.sizeLabel": "代码字体大小",
  "settings.typography.codeFont.familyA11y": "代码字体",
  "settings.typography.monospaceFont.title": "等宽字体",
  "settings.typography.monospaceFont.description": "代码块、差异、文件预览与终端。",
  "settings.typography.monospaceFont.familyA11y": "等宽字体",
  "settings.typography.terminalFont.title": "终端字体",
  "settings.typography.terminalFont.description": "终端输出，独立于代码块与差异。",
  "settings.typography.terminalFont.sizeLabel": "终端字体大小",
  "settings.typography.terminalFont.familyA11y": "终端字体",
  "settings.typography.separateFonts.title": "分别设置字体",
  "settings.typography.separateFonts.description":
    "为输入框、代码与终端分别设置字体，而非统一使用一款等宽字体。",
  "settings.typography.separateFonts.a11y": "分别设置字体",
  "settings.typography.fontSmoothing.title": "字体平滑",
  "settings.typography.fontSmoothing.description": "使用更细的灰度文字平滑，取代 macOS 默认效果。",
  "settings.typography.fontSmoothing.a11y": "字体平滑",
  "settings.typography.fontSmoothing.resetLabel": "字体平滑",
  "settings.typography.wordWrap.title": "自动换行",
  "settings.typography.wordWrap.description": "默认在代码块、差异与文件预览中对长行自动换行。",
  "settings.typography.wordWrap.a11y": "默认在代码块、差异与文件预览中自动换行",
  "settings.typography.wordWrap.resetLabel": "自动换行",
  "settings.threadDetails.title": "线程详情",
  "settings.threadDetails.resetLabel": "线程详情",
  "settings.threadDetails.description": "选择线程详情卡片显示的内容，也可以右键点击该卡片。",
  "settings.threadDetails.summary": "已开启 {enabled}/{total}",
  "settings.threadDetails.summaryA11y": "线程详情：已开启 {enabled}/{total}",
};
