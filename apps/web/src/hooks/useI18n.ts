import { useEffect, useState } from "react";

import { i18n } from "@t3tools/shared/i18n";

/**
 * Subscribe a component to locale changes so any `t()` call it makes re-renders
 * when the language switches. Returns the global i18n instance, so both
 * `const { t } = useI18n()` and `const i18n = useI18n()` are supported.
 */
export function useI18n() {
  const [, setVersion] = useState(0);
  useEffect(() => i18n.subscribe(() => setVersion((n) => n + 1)), []);
  return i18n;
}
