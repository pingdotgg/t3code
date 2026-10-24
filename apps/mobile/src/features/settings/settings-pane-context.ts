import { createContext } from "react";
import type { SettingsSheetTarget } from "./components/settings-sheet-targets";

export const SettingsPaneContext = createContext<{
  readonly role: "list" | "detail";
  readonly split: boolean;
  readonly selectedSection?: string;
  readonly selectSection?: (target: SettingsSheetTarget) => void;
} | null>(null);
