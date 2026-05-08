import { describe, expect, it } from "vitest";

import {
  applyAppIconPreferenceToDocument,
  APP_ICON_OPTIONS,
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
            if (!link) {
              return null;
            }
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
            if (rel) {
              links.set(`link[rel="${rel}"]`, link);
            }
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
        documentElement: {
          dataset: {} as Record<string, string>,
        },
      } as unknown as Document,
    };
  }

  it("resolves custom icon previews from the shipped app icon assets", () => {
    expect(APP_ICON_OPTIONS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "forma-arc",
          previewSrc: "/app-icons/forma-arc.png",
          faviconHref: "/app-icons/forma-arc.png",
          appleTouchIconHref: "/app-icons/forma-arc.png",
        }),
      ]),
    );
  });

  it("falls back to the default icon option for unknown values", () => {
    expect(resolveAppIconOption("missing" as never)).toMatchObject({
      id: "default",
      previewSrc: `/app-icons/${APP_DEFAULT_ICON_ID}.png`,
      faviconHref: `/app-icons/${APP_DEFAULT_ICON_ID}.png`,
      appleTouchIconHref: `/app-icons/${APP_DEFAULT_ICON_ID}.png`,
    });
  });

  it("resolves the default option to the current build icon asset", () => {
    expect(resolveAppIconOption("default")).toMatchObject({
      id: "default",
      previewSrc: `/app-icons/${APP_DEFAULT_ICON_ID}.png`,
      faviconHref: `/app-icons/${APP_DEFAULT_ICON_ID}.png`,
      appleTouchIconHref: `/app-icons/${APP_DEFAULT_ICON_ID}.png`,
    });
  });

  it("applies icon link tags to the document head", () => {
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
