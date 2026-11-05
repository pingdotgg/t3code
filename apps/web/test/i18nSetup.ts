import { createI18n } from "@palamedes/core";
import { setClientI18n, setServerI18nGetter } from "@palamedes/runtime";

import { messages } from "../src/locales/en.po";

const i18n = createI18n({ locale: "en" });
i18n.load("en", messages);
setClientI18n(i18n);
setServerI18nGetter(() => i18n);
