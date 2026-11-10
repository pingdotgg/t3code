import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  type AnyRouter,
} from "@tanstack/react-router";
import { act as reactAct, createContext, use, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vite-plus/test";
import { page, utils, type Locator, type LocatorSelectors } from "vite-plus/test/browser";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// React warns about every update outside act() while this flag is on, and a real
// browser drives updates from userEvent, timers and network that act() cannot wrap.
// So it is on only while act() runs, and nested calls restore the outer value.
export async function act<T>(callback: () => T | Promise<T>): Promise<T> {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    return await reactAct(async () => await callback());
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

export interface RenderOptions {
  /**
   * Element to render into, for tests that size or style it before the first render.
   * The screen owns it from then on and removes it on dispose.
   */
  readonly container?: HTMLElement;
  /** Initial location of the test router, or `false` to render without one. */
  readonly router?: string | false;
}

/** Queries are scoped to the container; use `page` for portals such as menus and dialogs. */
export interface Screen extends LocatorSelectors, AsyncDisposable {
  readonly container: HTMLElement;
  readonly locator: Locator;
  readonly router: AnyRouter | undefined;
  readonly rerender: (ui: ReactNode) => Promise<void>;
  /** Unmounts early, to test cleanup effects. Dispose still removes the container. */
  readonly unmount: () => Promise<void>;
}

const RoutedUi = createContext<ReactNode>(null);

function RoutedUiOutlet() {
  return use(RoutedUi);
}

// Links and navigation hooks need a router even when the test is not about routing.
function createTestRouter(path: string): AnyRouter {
  return createRouter({
    routeTree: createRootRoute({ component: RoutedUiOutlet }),
    history: createMemoryHistory({ initialEntries: [path] }),
    // The router's error UI would otherwise turn a crash into a passing negative assertion.
    disableGlobalCatchBoundary: true,
  });
}

/**
 * Renders `ui` for one test. Acquire it with `await using` so the tree unmounts and the
 * container and router go away when the test ends, pass or fail.
 */
export async function render(
  ui: ReactNode,
  { container = document.createElement("div"), router: path = "/" }: RenderOptions = {},
): Promise<Screen> {
  if (!container.isConnected) document.body.append(container);
  const root = createRoot(container);
  const router = path === false ? undefined : createTestRouter(path);
  // The router element is created once so a rerender updates the tree instead of remounting it.
  const routerElement = router && <RouterProvider router={router} />;
  const wrap = (node: ReactNode) =>
    routerElement ? <RoutedUi value={node}>{routerElement}</RoutedUi> : node;

  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(() => root.unmount());
  };
  const screen: Screen = {
    ...utils.getElementLocatorSelectors(container),
    container,
    locator: page.elementLocator(container),
    router,
    rerender: (next) => act(() => root.render(wrap(next))),
    unmount,
    async [Symbol.asyncDispose]() {
      try {
        await unmount();
      } finally {
        container.remove();
      }
    },
  };

  try {
    await screen.rerender(ui);
  } catch (error) {
    await screen[Symbol.asyncDispose]();
    throw error;
  }
  return screen;
}

/** Fake timers for one test: `using _timers = fakeTimers()`. */
export function fakeTimers(config?: Parameters<typeof vi.useFakeTimers>[0]): Disposable {
  vi.useFakeTimers(config);
  return { [Symbol.dispose]: () => void vi.useRealTimers() };
}

/** Replaces one global for one test and restores exactly that global on dispose. */
export function stubGlobal(name: string, value: unknown): Disposable {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
  return {
    [Symbol.dispose]() {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    },
  };
}
