// Fork: whether Kaluwa's theme studio panel is open, and which edge it is docked to.
import { create } from "zustand";

export type KaluwaStudioDock = "right" | "left";

type KaluwaStudioPanelStore = {
  open: boolean;
  dock: KaluwaStudioDock;
  setDock: (dock: KaluwaStudioDock) => void;
};

export const useKaluwaStudioPanelStore = create<KaluwaStudioPanelStore>((set) => ({
  open: false,
  dock: "right",
  setDock: (dock) => set({ dock }),
}));

export function openKaluwaThemeStudio(): void {
  useKaluwaStudioPanelStore.setState({ open: true });
}

export function closeKaluwaThemeStudio(): void {
  useKaluwaStudioPanelStore.setState({ open: false });
}
