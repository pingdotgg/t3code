import i18next, { type i18n as I18n } from "i18next";
import { initReactI18next } from "react-i18next";

/**
 * 切换点：06 号任务在 web 侧落地共享的 locales/<lang>/<namespace>.json 后，把这里的内联
 * resources 换成对共享 JSON 的 import，其余初始化不动。
 */
const resources = {
  en: {
    translation: {
      "settings.language.title": "Language",
      "settings.language.footer":
        "Interface language for this device. Change it on any connected server and every client follows.",
      "settings.language.option.system": "Follow system",
      "settings.language.option.en": "English",
      "settings.language.option.zh-Hans": "Simplified Chinese",
    },
  },
  "zh-Hans": {
    translation: {
      "settings.language.title": "界面语言",
      "settings.language.footer":
        "本设备的界面显示语言。在任一台已连接的服务器上修改，所有客户端同步生效。",
      "settings.language.option.system": "跟随系统",
      "settings.language.option.en": "English",
      "settings.language.option.zh-Hans": "简体中文",
    },
  },
} as const;

i18next.use(initReactI18next).init({
  resources,
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export const i18n: I18n = i18next;
