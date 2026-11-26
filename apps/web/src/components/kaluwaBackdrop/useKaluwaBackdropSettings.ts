// Fork: reads and saves Kaluwa's backdrop settings on this device.
import { useEnvironmentStageLabel } from "../SidebarStageBackdrop";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  defaultBackdropSettings,
  KALUWA_BACKDROP_STORAGE_KEY,
  KaluwaBackdropSettingsSchema,
  type BackdropImageSettings,
  type KaluwaBackdropSettings,
} from "./backdropSettings";

export type KaluwaBackdropPatch = Partial<Omit<KaluwaBackdropSettings, "image">> & {
  readonly image?: Partial<BackdropImageSettings>;
};

/** True in the Kaluwa (-local) build, whose defaults turn the art on. */
function useIsKaluwaFlavour(): boolean {
  return useEnvironmentStageLabel().trim().toLowerCase() === "local";
}

export function useKaluwaBackdropSettings() {
  const isKaluwa = useIsKaluwaFlavour();
  const defaults = defaultBackdropSettings(isKaluwa);
  const [settings, setSettings] = useLocalStorage(
    KALUWA_BACKDROP_STORAGE_KEY,
    defaults,
    KaluwaBackdropSettingsSchema,
  );
  const update = (patch: KaluwaBackdropPatch) =>
    setSettings((current) => ({
      ...current,
      ...patch,
      image: { ...current.image, ...patch.image },
    }));
  const reset = () => setSettings(defaults);
  return { settings, defaults, isKaluwa, update, reset };
}
