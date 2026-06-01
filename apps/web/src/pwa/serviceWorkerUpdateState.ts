import { create } from "zustand";

type ServiceWorkerUpdater = () => Promise<void>;

export type PwaServiceWorkerUpdateStatus = "idle" | "ready" | "updating";

interface PwaServiceWorkerUpdateState {
  errorMessage: string | null;
  status: PwaServiceWorkerUpdateStatus;
  updateServiceWorker: ServiceWorkerUpdater | null;
  reloadForUpdate: () => void;
  showUpdateAvailable: (updateServiceWorker: ServiceWorkerUpdater) => void;
}

function describeUpdateError(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

export const usePwaServiceWorkerUpdateStore = create<PwaServiceWorkerUpdateState>((set, get) => ({
  errorMessage: null,
  status: "idle",
  updateServiceWorker: null,

  reloadForUpdate: () => {
    const { status, updateServiceWorker } = get();
    if (status === "updating" || !updateServiceWorker) {
      return;
    }

    set({ errorMessage: null, status: "updating" });

    void updateServiceWorker()
      .then(() => {
        window.setTimeout(() => {
          set((state) => {
            if (state.status !== "updating" || state.updateServiceWorker !== updateServiceWorker) {
              return state;
            }
            return { status: "ready" };
          });
        }, 5_000);
      })
      .catch((error: unknown) => {
        console.warn("PWA service worker update failed", error);
        set((state) => {
          if (state.updateServiceWorker !== updateServiceWorker) {
            return state;
          }
          return { errorMessage: describeUpdateError(error), status: "ready" };
        });
      });
  },

  showUpdateAvailable: (updateServiceWorker) => {
    set((state) => {
      if (state.status === "updating") {
        return state;
      }
      if (
        state.status === "ready" &&
        state.errorMessage === null &&
        state.updateServiceWorker === updateServiceWorker
      ) {
        return state;
      }
      return { errorMessage: null, status: "ready", updateServiceWorker };
    });
  },
}));

export function showPwaServiceWorkerUpdateAvailable(
  updateServiceWorker: ServiceWorkerUpdater,
): void {
  usePwaServiceWorkerUpdateStore.getState().showUpdateAvailable(updateServiceWorker);
}
