import { expect, it, vi } from "vite-plus/test";

vi.mock("./appInit", () => ({ startAppServices: () => ({ load: async () => {} }) }));
vi.mock("./AppRoot", () => ({ AppRoot: () => null }));
vi.mock("./i18n/runtime", () => ({ whenLocaleReady: async () => {} }));
vi.mock("react-dom/client", () => ({ default: { createRoot: () => ({ render: () => {} }) } }));

// Boots main in a fresh page that shares the tab's sessionStorage, as a reload does.
async function bootMain(
  { sessionStorage = new Map<string, string>(), anyHover = true },
  interact: (page: EventTarget) => void,
) {
  vi.resetModules();
  const reload = vi.fn().mockName("location.reload");
  const page = Object.assign(new EventTarget(), {
    sessionStorage: {
      getItem: (key: string) => sessionStorage.get(key) ?? null,
      setItem: (key: string, value: string) => sessionStorage.set(key, value),
      removeItem: (key: string) => sessionStorage.delete(key),
    },
    location: { reload },
    matchMedia: (query: string) => ({ matches: query === "(any-hover: hover)" && anyHover }),
  });
  const root = { dataset: {} as Record<string, string> };
  vi.stubGlobal("window", page);
  vi.stubGlobal("document", { getElementById: () => ({}), documentElement: root });
  try {
    const { startup } = await import("./main");
    await startup;
    interact(page);
    return { reload, root };
  } finally {
    vi.unstubAllGlobals();
  }
}

const failLazyChunk = (page: EventTarget) =>
  page.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));

it("reloads only once when a lazy chunk fails after every boot", async () => {
  const sessionStorage = new Map<string, string>();

  expect((await bootMain({ sessionStorage }, failLazyChunk)).reload).toHaveBeenCalledTimes(1);
  expect((await bootMain({ sessionStorage }, failLazyChunk)).reload).not.toHaveBeenCalled();
});

it.each([
  { anyHover: false, pointerTypes: ["touch", "pen"], marked: false },
  { anyHover: false, pointerTypes: ["touch", "mouse"], marked: true },
  { anyHover: true, pointerTypes: ["mouse"], marked: false },
])(
  "marks mouse hover with any-hover $anyHover after $pointerTypes moves",
  async ({ anyHover, pointerTypes, marked }) => {
    const { root } = await bootMain({ anyHover }, (page) => {
      for (const pointerType of pointerTypes) {
        page.dispatchEvent(Object.assign(new Event("pointermove"), { pointerType }));
      }
    });

    expect("mouseHover" in root.dataset).toBe(marked);
  },
);
