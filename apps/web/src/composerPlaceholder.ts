import { translateDynamic } from "./i18nCore";

export function defaultComposerPlaceholder(): string {
  return translateDynamic("composer:placeholder.default");
}
