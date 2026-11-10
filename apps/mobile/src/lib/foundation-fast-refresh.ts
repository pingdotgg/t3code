export interface FoundationHotModule {
  readonly accept: (callback?: () => void) => void;
  readonly dispose: (callback: () => void) => void;
}

export function disposeOnFoundationReplace(
  hotModule: FoundationHotModule | undefined,
  dispose: () => void | Promise<void>,
): void {
  if (hotModule === undefined || typeof __DEV__ === "undefined" || !__DEV__) return;

  hotModule.dispose(() => {
    try {
      void Promise.resolve(dispose()).catch((error: unknown) => {
        console.error("[fast-refresh] could not dispose replaced mobile foundation", error);
      });
    } catch (error) {
      console.error("[fast-refresh] could not dispose replaced mobile foundation", error);
    }
  });
}
