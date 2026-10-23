import { useViewabilityAmount } from "@legendapp/list/react-native";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

function createVisibilityStore(onObserved: (observed: boolean) => void) {
  let visible = false;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => visible,
    subscribe(listener: () => void) {
      listeners.add(listener);
      onObserved(true);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          onObserved(false);
        }
      };
    },
    setVisible(next: boolean) {
      if (visible === next) return;
      visible = next;
      for (const listener of listeners) listener();
    },
  };
}

const VisibilityContext = createContext<ReturnType<typeof createVisibilityStore> | null>(null);
const subscribeNever = () => () => {};
const hiddenSnapshot = () => false;

export function useThreadMediaVisible(override?: boolean): boolean {
  const context = useContext(VisibilityContext);
  const store = override === undefined ? context : null;
  const visible = useSyncExternalStore(
    store?.subscribe ?? subscribeNever,
    store?.getSnapshot ?? hiddenSnapshot,
    hiddenSnapshot,
  );
  return override ?? visible;
}

function VisibilityObserver(props: { readonly onVisible: (visible: boolean) => void }) {
  const { onVisible } = props;
  const [visible, setVisible] = useState(false);
  useViewabilityAmount(useCallback((token) => setVisible(token.sizeVisible > 0), []));
  useLayoutEffect(() => onVisible(visible), [onVisible, visible]);
  // A keyed video handoff can keep the observer mounted across the last unsubscribe.
  useLayoutEffect(() => () => onVisible(false), [onVisible]);
  return null;
}

/** LegendList has one callback slot per row, shared by every video in that row. */
export function ThreadMediaVisibility(props: { readonly children: ReactNode }) {
  const [observed, setObserved] = useState(false);
  const [store] = useState(() => createVisibilityStore(setObserved));
  return (
    <VisibilityContext value={store}>
      {props.children}
      {observed ? <VisibilityObserver onVisible={store.setVisible} /> : null}
    </VisibilityContext>
  );
}
