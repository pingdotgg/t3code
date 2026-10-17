// @vitest-environment jsdom

import { useAtomValue } from "@effect/atom-react";
import { act, createElement, type PropsWithChildren, useState } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { environmentCatalog } from "./connection/catalog";

const fixture = vi.hoisted(() => {
  let completeCleanup = () => {};
  const cleanupFinished = new Promise<void>((resolve) => {
    completeCleanup = resolve;
  });
  return { signOut: () => {}, cleanupFinished, completeCleanup };
});

vi.mock("@clerk/react", async () => {
  const { createContext, useContext } = await import("react");
  const AuthContext = createContext({ isSignedIn: false });
  const getToken = async () => null;
  return {
    ClerkProvider: ({ children }: PropsWithChildren) => {
      const [isSignedIn, setSignedIn] = useState(true);
      fixture.signOut = () => setSignedIn(false);
      return createElement(AuthContext.Provider, { value: { isSignedIn } }, children);
    },
    useAuth: () => {
      const { isSignedIn } = useContext(AuthContext);
      return { isLoaded: true, isSignedIn, userId: isSignedIn ? "demo-account" : null, getToken };
    },
  };
});

vi.mock("./connection/catalog", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const catalogValueAtom = Atom.make({
    entries: new Map([
      ["relay-demo", true],
      ["independent-direct", false],
    ]),
  });
  return {
    environmentCatalog: {
      catalogValueAtom,
      // Keep registry selection real. This in-memory catalog isolates bootstrap
      // ownership from network and persistence; registry.test covers route removal.
      removeRelayEnvironments: {
        label: "test:remove-relay-environments",
        run: async (registry: import("effect/reactivity/AtomRegistry").AtomRegistry) => {
          registry.set(catalogValueAtom, {
            entries: new Map(
              [...registry.get(catalogValueAtom).entries].filter(([, relay]) => !relay),
            ),
          });
          fixture.completeCleanup();
          return AsyncResult.success(undefined);
        },
      },
    },
  };
});

function CatalogView() {
  const { entries } = useAtomValue(environmentCatalog.catalogValueAtom);
  return createElement("div", null, [...entries.keys()].join(", "));
}

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  RouterProvider: () => createElement(CatalogView),
}));
vi.mock("./router", () => ({ getRouter: () => ({ load: async () => {} }) }));
vi.mock("./env", () => ({ isElectron: false }));
vi.mock("./providerAuthDelivery", () => ({ prepareProviderAuthDelivery: () => {} }));
vi.mock("./cloud/publicConfig", () => ({
  hasCloudPublicConfig: () => true,
  resolveRelayClerkTokenOptions: () => ({}),
}));
vi.mock("./lib/runtime", () => ({
  runtime: { runPromiseExit: async () => ({ _tag: "Success", value: undefined }) },
}));
vi.mock("./browser/BrowserProfileReporter", () => ({ BrowserProfileReporter: () => null }));
vi.mock("./browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("./components/QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));

// Retain the actual renderer while capturing its root for teardown.
let unmount: (() => void) | undefined;
vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  const createRoot: typeof actual.createRoot = (...args) => {
    const root = actual.createRoot(...args);
    unmount = () => root.unmount();
    return root;
  };
  return { ...actual, default: { ...actual, createRoot }, createRoot };
});

afterEach(async () => {
  await act(() => unmount?.());
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("sign-out removes Relay environments from the catalog rendered by the app", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_synthetic");
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);

  // Run the real entry point, lazy auth shell, ManagedRelayAuthProvider, AppRoot,
  // RegistryContext and useAtomCommand. Neither registry nor command hook is mocked.
  await act(async () => {
    const { startup } = await import("./main");
    await startup;
  });
  expect(container.textContent).toContain("relay-demo");
  expect(container.textContent).toContain("independent-direct");

  await act(() => fixture.signOut());
  await act(async () => {
    await fixture.cleanupFinished;
  });

  expect(container.textContent).not.toContain("relay-demo");
  expect(container.textContent).toContain("independent-direct");
});
