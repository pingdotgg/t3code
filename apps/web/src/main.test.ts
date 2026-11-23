import { expect, it, vi } from "vite-plus/test";

vi.mock("./appInit", () => ({ startAppServices: () => ({ load: async () => {} }) }));
vi.mock("./AppRoot", () => ({ AppRoot: () => null }));
vi.mock("./i18n/runtime", () => ({ whenLocaleReady: async () => {} }));
vi.mock("react-dom/client", () => ({ default: { createRoot: () => ({ render: () => {} }) } }));

// Boots the entry in a fresh page that shares the tab's sessionStorage, as a reload does.
async function bootMain(
  { sessionStorage = new Map<string, string>(), anyHover = true },
  interact: (page: EventTarget, setAnyHover: (matches: boolean) => void) => void,
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
    matchMedia: (query: string) => ({
      get matches() {
        return anyHover && query.endsWith("hover: hover)");
      },
      addEventListener: (type: string, listener: () => void) =>
        page.addEventListener(type, listener),
    }),
  });
  const setAnyHover = (matches: boolean) => {
    anyHover = matches;
    page.dispatchEvent(new Event("change"));
  };
  const root = {
    attributes: new Set<string>(),
    toggleAttribute: (name: string, force: boolean) =>
      force ? root.attributes.add(name) : root.attributes.delete(name),
  };
  vi.stubGlobal("window", page);
  vi.stubGlobal("document", { getElementById: () => ({}), documentElement: root });
  try {
    const { boot } = await import("./bootstrap");
    await boot;
    interact(page, setAnyHover);
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
  { anyHover: false, input: "pointermove:touch pointermove:pen", marked: false },
  { anyHover: false, input: "pointermove:touch pointermove:mouse", marked: true },
  { anyHover: false, input: "pointermove:mouse pointermove:touch", marked: false },
  { anyHover: false, input: "pointermove:mouse pointerdown:mouse", marked: true },
  {
    anyHover: false,
    input: "pointermove:mouse pointerdown:touch pointerdown:mouse",
    marked: false,
  },
  { anyHover: true, input: "pointermove:touch", marked: true },
  { anyHover: true, input: "pointermove:touch any-hover:none pointermove:mouse", marked: true },
  { anyHover: true, input: "pointermove:mouse any-hover:none pointermove:touch", marked: false },
])(
  "hover markers are $marked with any-hover $anyHover after $input",
  async ({ anyHover, input, marked }) => {
    const { root } = await bootMain({ anyHover }, (page, setAnyHover) => {
      for (const event of input.split(" ")) {
        const [type = "", pointerType] = event.split(":");
        if (type === "any-hover") setAnyHover(false);
        else page.dispatchEvent(Object.assign(new Event(type), { pointerType }));
      }
    });

    expect([...root.attributes].toSorted()).toEqual(marked ? ["data-any-hover", "data-hover"] : []);
  },
);
