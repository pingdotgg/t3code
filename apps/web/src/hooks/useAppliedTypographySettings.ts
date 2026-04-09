import { useEffect } from "react";
import { applyTypographySettings } from "../typography";
import { useTypographySettings } from "./useTypographySettings";

export function useAppliedTypographySettings() {
  const typographySettings = useTypographySettings();

  useEffect(() => {
    applyTypographySettings(document.documentElement, typographySettings);
  }, [typographySettings]);
}
