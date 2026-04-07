import { useEffect } from "react";
import { useSettings } from "./useSettings";
import { applyTypographySettings, pickTypographySettings } from "../typography";

export function useAppliedTypographySettings() {
  const typographySettings = useSettings(pickTypographySettings);

  useEffect(() => {
    applyTypographySettings(document.documentElement, typographySettings);
  }, [typographySettings]);
}
