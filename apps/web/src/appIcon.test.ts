import { describe, expect, it } from "vitest";

import {
  APP_ICON_OPTIONS,
  applyAppIconPreferenceToDocument,
  resolveAppIconOption,
} from "./appIcon";
import { APP_DEFAULT_ICON_ID } from "./branding";

describe("appIcon", () => {
  function createDocumentStub() {
    const links = new Map<string, { attributes: Map<string, string> }>();
    return {
      document: {
        head: {
          querySelector(selector: string) {
            const link = links.get(selector);
            if (!link) return null;
            return {
              getAttribute(name: string) {
                return link.attributes.get(name) ?? null;
              },
              setAttribute(name: string, value: string) {
                link.attributes.set(name, value);
              },
            };
          },
          appendChild(link: { attributes: Map<string, string> }) {
            const rel = link.attributes.get("rel");
            if (rel) links.set(`link[rel="${rel}"]`, link);
          },
        },
        createElement() {
          return {
            attributes: new Map<string, string>(),
            getAttribute(name: string) {
              return this.attributes.get(name) ?? null;
            },
            setAttribute(name: string, value: string) {
              this.attributes.set(name, value);
            },
          };
        },
        documentElement: { dataset: {} as Record<string, string> },
      } as unknown as Document,
    };
  }

  it("ships every custom Forma icon", () => {
    expect(APP_ICON_OPTIONS.map(({ id }) => id)).toEqual([
      "default",
      "forma-arc",
      "forma-fluted",
      "forma-foil",
      "forma-blueprint",
    ]);
  });

  it("uses the current build artwork for default and unknown values", () => {
    expect(resolveAppIconOption("default").previewSrc).toBe(
      `/app-icons/${APP_DEFAULT_ICON_ID}.png`,
    );
    expect(resolveAppIconOption("missing" as never).id).toBe("default");
  });

  it("updates favicon and Apple touch icon links", () => {
    const { document } = createDocumentStub();
    applyAppIconPreferenceToDocument({ appIcon: "forma-blueprint" }, document);
    expect(document.head.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe(
      "/app-icons/forma-blueprint.png",
    );
    expect(document.head.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href")).toBe(
      "/app-icons/forma-blueprint.png",
    );
    expect(document.documentElement.dataset.appIcon).toBe("forma-blueprint");
  });
});
