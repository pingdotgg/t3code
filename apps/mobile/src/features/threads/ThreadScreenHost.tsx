import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { View } from "react-native";

import { ScreenContent } from "../../components/ui/ScreenContent";
import { ThreadDetailScreen, type ThreadDetailScreenProps } from "./ThreadDetailScreen";

type ThreadScreenContent =
  | { readonly props: ThreadDetailScreenProps; readonly header?: ReactNode }
  | { readonly fallback: ReactNode; readonly header?: ReactNode };

type Handler = (...args: never[]) => unknown;

function createThreadScreenStore() {
  let current: ThreadScreenContent | null = null;
  // One function per handler prop that calls the controller's latest handler, so a handler the
  // controller recreates does not re-render the thread screen. Each thread gets its own set, so a
  // send that awaits before calling its handler still reaches the thread it started on.
  let handlers = {
    thread: null as string | null,
    latest: {} as Record<string, unknown>,
    stable: new Map<string, Handler>(),
  };
  const handler = (key: string) => {
    const set = handlers;
    let stable = set.stable.get(key);
    if (stable === undefined) {
      stable = (...args) => (set.latest[key] as Handler | undefined)?.(...args);
      set.stable.set(key, stable);
    }
    return stable;
  };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish: (content: ThreadScreenContent) => {
      let next = content;
      if ("props" in content) {
        const latest = content.props as unknown as Record<string, unknown>;
        const thread = threadKey(content.props);
        if (thread !== handlers.thread) handlers = { thread, latest, stable: new Map() };
        else handlers.latest = latest;
        const shown = current !== null && "props" in current ? current : null;
        const shownProps = (shown?.props ?? {}) as Record<string, unknown>;
        // Controllers rebuild arrays and records with the same contents on most renders; the
        // screen keeps the ones it has, so its memoized feed and composer skip the update.
        const props = Object.fromEntries(
          Object.entries(latest).map(([key, value]) => [
            key,
            typeof value === "function"
              ? handler(key)
              : sameContents(shownProps[key], value)
                ? shownProps[key]
                : value,
          ]),
        ) as unknown as ThreadDetailScreenProps;
        const sameProps = shown !== null && shallowEqual(shown.props, props);
        // Unchanged props keep their identity, so only the header re-renders when it alone changed.
        if (sameProps && shown.header === content.header) return;
        next = { props: sameProps ? shown.props : props, header: content.header };
      }
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

function threadKey(props: ThreadDetailScreenProps): string | null {
  const thread = props.selectedThread as ThreadDetailScreenProps["selectedThread"] | undefined;
  return thread === undefined ? null : `${thread.environmentId}:${thread.id}`;
}

function sameContents(previous: unknown, next: unknown): boolean {
  if (Object.is(previous, next)) return true;
  if (Array.isArray(previous) && Array.isArray(next)) {
    return previous.length === next.length && previous.every((item, index) => item === next[index]);
  }
  return isPlainRecord(previous) && isPlainRecord(next) && shallowEqual(previous, next);
}

function isPlainRecord(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function shallowEqual(previous: object, next: object): boolean {
  const previousRecord = previous as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  const keys = Object.keys(nextRecord);
  return (
    keys.length === Object.keys(previousRecord).length &&
    keys.every(
      (key) =>
        Object.hasOwn(previousRecord, key) && Object.is(previousRecord[key], nextRecord[key]),
    )
  );
}

const ThreadScreenContext = createContext<ReturnType<typeof createThreadScreenStore> | null>(null);

function ThreadScreenOutlet() {
  const store = useContext(ThreadScreenContext)!;
  const content = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (content === null) return null;
  const screenProps = "props" in content ? content.props : null;
  const fallback = "fallback" in content ? content.fallback : null;
  return (
    <>
      {content.header}
      <ScreenContent surface="canvas">
        {screenProps === null ? fallback : <ThreadDetailScreen {...screenProps} />}
      </ScreenContent>
    </>
  );
}

// Controllers can change from draft to live without replacing the native screen,
// the keyboard host, or the editor. Publish before paint to avoid an intermediate frame.
export function ThreadScreenHost({ children }: { readonly children: ReactNode }) {
  const [store] = useState(createThreadScreenStore);
  return (
    <ThreadScreenContext.Provider value={store}>
      {children}
      <View className="flex-1 bg-screen android:bg-header">
        <ThreadScreenOutlet />
      </View>
    </ThreadScreenContext.Provider>
  );
}

/** Handler props reach the screen as stable functions; call them from handlers and effects only. */
export function ThreadScreenBinding({
  header,
  ...props
}: ThreadDetailScreenProps & { readonly header?: ReactNode }) {
  const store = useContext(ThreadScreenContext)!;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the route's thread screen props to the external store the outlet reads
  useLayoutEffect(() => {
    store.publish({ props, header });
  });
  return null;
}

export function ThreadScreenFallback({
  children,
  header,
}: {
  readonly children: ReactNode;
  readonly header?: ReactNode;
}) {
  const store = useContext(ThreadScreenContext)!;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the fallback content and header to the external store the outlet reads
  useLayoutEffect(() => {
    store.publish({ fallback: children, header });
  });
  return null;
}
