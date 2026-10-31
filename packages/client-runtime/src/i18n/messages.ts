/**
 * Interface/appearance settings messages. English is the source of truth: its
 * keys define this domain's catalog and every other locale maps onto them. A
 * locale missing a key falls back to English.
 */
export const enMessages = {
  "settings.interface.title": "Interface",
  "settings.interface.language.title": "Language",
  "settings.interface.language.description": "Choose the language for the interface.",
  "settings.interface.language.a11y": "Interface language",
  "settings.interface.language.system": "System default",
  "settings.interface.contrast.title": "Contrast",
  "settings.interface.contrast.resetLabel": "contrast",
  "settings.interface.contrast.description":
    "Adjust the contrast of colors and borders across the interface.",
  "settings.interface.contrast.a11y": "Contrast",
  "settings.interface.glassOpacity.title": "Glass opacity",
  "settings.interface.glassOpacity.resetLabel": "glass opacity",
  "settings.interface.glassOpacity.description":
    "Higher values make menus, dialogs, and the composer more solid.",
  "settings.interface.glassOpacity.a11y": "Glass opacity",
  "settings.interface.chatWidth.title": "Chat width",
  "settings.interface.chatWidth.resetLabel": "chat width",
  "settings.interface.chatWidth.description":
    "Set how wide messages and the composer can grow on large screens.",
  "settings.interface.chatWidth.a11y": "Chat width",
  "settings.interface.chatWidth.comfortable": "Comfortable (default)",
  "settings.interface.chatWidth.wide": "Wide",
  "settings.interface.chatWidth.full": "Full",
  "settings.interface.effortDisplay.title": "Effort display",
  "settings.interface.effortDisplay.resetLabel": "effort display",
  "settings.interface.effortDisplay.description":
    "Show reasoning effort in the composer as its name, such as High, or as bars.",
  "settings.interface.effortDisplay.a11y": "Effort display",
  "settings.interface.effortDisplay.word": "Word (default)",
  "settings.interface.effortDisplay.bars": "Bars",
  "settings.interface.mathRendering.title": "Math rendering",
  "settings.interface.mathRendering.resetLabel": "math rendering",
  "settings.interface.mathRendering.description":
    "Typeset LaTeX math, such as $x^2$ or \\[x^2\\], in messages and Markdown previews. The composer keeps TeX source editable.",
  "settings.interface.mathRendering.a11y": "Render math",
  "settings.interface.panelAnimations.title": "Panel animations",
  "settings.interface.panelAnimations.resetLabel": "panel animations",
  "settings.interface.panelAnimations.description": "Set how fast panels open and close.",
  "settings.interface.panelAnimations.a11y": "Panel animation duration",
  "settings.interface.environmentIdentification.title": "Environment identification",
  "settings.interface.environmentIdentification.resetLabel": "environment identification",
  "settings.interface.environmentIdentification.description.stages":
    "Choose how Dev and Nightly environments are identified.",
  "settings.interface.environmentIdentification.description.header":
    "Show Dev or Nightly artwork in the sidebar header.",
  "settings.interface.environmentIdentification.a11y": "Environment identification",
  "settings.interface.environmentIdentification.artwork": "Artwork",
  "settings.interface.environmentIdentification.nightlyArtwork": "Nightly artwork",
  "settings.interface.environmentIdentification.devArtwork": "Dev artwork",
  "settings.interface.environmentIdentification.pill": "Version pill",
  "settings.interface.environmentIdentification.none": "None",
  "settings.interface.composerContext.title": "Composer context",
  "settings.interface.composerContext.resetLabel": "composer context",
  "settings.interface.composerContext.description":
    "Keep branch and worktree controls below the composer after a thread starts.",
  "settings.interface.composerContext.a11y": "Keep composer context visible in active threads",
} as const;

export const zhHansMessages: Partial<Record<keyof typeof enMessages, string>> = {
  "settings.interface.title": "界面",
  "settings.interface.language.title": "语言",
  "settings.interface.language.description": "选择界面显示语言。",
  "settings.interface.language.a11y": "界面语言",
  "settings.interface.language.system": "跟随系统",
  "settings.interface.contrast.title": "对比度",
  "settings.interface.contrast.resetLabel": "对比度",
  "settings.interface.contrast.description": "调整界面颜色与边框的对比度。",
  "settings.interface.contrast.a11y": "对比度",
  "settings.interface.glassOpacity.title": "玻璃不透明度",
  "settings.interface.glassOpacity.resetLabel": "玻璃不透明度",
  "settings.interface.glassOpacity.description": "数值越高，菜单、对话框与输入框越不透明。",
  "settings.interface.glassOpacity.a11y": "玻璃不透明度",
  "settings.interface.chatWidth.title": "对话宽度",
  "settings.interface.chatWidth.resetLabel": "对话宽度",
  "settings.interface.chatWidth.description": "设置大屏幕上消息与输入框的最大宽度。",
  "settings.interface.chatWidth.a11y": "对话宽度",
  "settings.interface.chatWidth.comfortable": "舒适（默认）",
  "settings.interface.chatWidth.wide": "宽",
  "settings.interface.chatWidth.full": "全宽",
  "settings.interface.effortDisplay.title": "推理强度显示",
  "settings.interface.effortDisplay.resetLabel": "推理强度显示",
  "settings.interface.effortDisplay.description":
    "在输入框中以名称（如 High）或进度条形式显示推理强度。",
  "settings.interface.effortDisplay.a11y": "推理强度显示",
  "settings.interface.effortDisplay.word": "文字（默认）",
  "settings.interface.effortDisplay.bars": "进度条",
  "settings.interface.mathRendering.title": "数学公式",
  "settings.interface.mathRendering.resetLabel": "数学公式",
  "settings.interface.mathRendering.description":
    "在消息与 Markdown 预览中排版 LaTeX 公式（如 $x^2$ 或 \\[x^2\\]）。输入框中的 TeX 源码保持可编辑。",
  "settings.interface.mathRendering.a11y": "渲染数学公式",
  "settings.interface.panelAnimations.title": "面板动画",
  "settings.interface.panelAnimations.resetLabel": "面板动画",
  "settings.interface.panelAnimations.description": "设置面板打开与关闭的速度。",
  "settings.interface.panelAnimations.a11y": "面板动画时长",
  "settings.interface.environmentIdentification.title": "环境标识",
  "settings.interface.environmentIdentification.resetLabel": "环境标识",
  "settings.interface.environmentIdentification.description.stages":
    "选择 Dev 与 Nightly 环境的标识方式。",
  "settings.interface.environmentIdentification.description.header":
    "在侧边栏头部显示 Dev 或 Nightly 图标。",
  "settings.interface.environmentIdentification.a11y": "环境标识",
  "settings.interface.environmentIdentification.artwork": "图标",
  "settings.interface.environmentIdentification.nightlyArtwork": "Nightly 图标",
  "settings.interface.environmentIdentification.devArtwork": "Dev 图标",
  "settings.interface.environmentIdentification.pill": "版本徽标",
  "settings.interface.environmentIdentification.none": "不显示",
  "settings.interface.composerContext.title": "输入框上下文",
  "settings.interface.composerContext.resetLabel": "输入框上下文",
  "settings.interface.composerContext.description":
    "线程开始后，在输入框下方保留分支与 worktree 控件。",
  "settings.interface.composerContext.a11y": "在活动线程中保持输入框上下文可见",
};
