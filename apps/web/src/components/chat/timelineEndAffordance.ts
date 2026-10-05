import { Debouncer } from "@tanstack/react-pacer";

/** Keep the recovery button available even if automatic follow stalls. */
export function createTimelineEndAffordance(setVisible: (visible: boolean) => void) {
  const show = new Debouncer(() => setVisible(true), { wait: 150 });
  return {
    cancel: () => show.cancel(),
    report(isAtEnd: boolean) {
      if (isAtEnd) {
        show.cancel();
        setVisible(false);
      } else if (!show.store.state.isPending) {
        // Repeated size/scroll reports must not keep postponing the button.
        show.maybeExecute();
      }
    },
  };
}
