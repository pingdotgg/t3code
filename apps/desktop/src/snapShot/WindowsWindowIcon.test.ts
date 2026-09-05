import { assert, describe, it } from "vite-plus/test";
import {
  appIconBitmapWithApi,
  premultipliedIconPixels,
  type WindowsIconApi,
} from "./WindowsWindowIcon.ts";

describe("premultipliedIconPixels", () => {
  it("premultiplies straight-alpha icons in place", () => {
    const color = Buffer.from([200, 100, 50, 128, 10, 20, 30, 255, 90, 90, 90, 0]);

    assert.strictEqual(premultipliedIconPixels(color, undefined), color);
    assert.deepEqual([...color], [100, 50, 25, 128, 10, 20, 30, 255, 0, 0, 0, 0]);
  });

  it("derives alpha from the AND mask when the color plane has none", () => {
    const color = Buffer.from([200, 100, 50, 0, 10, 20, 30, 0]);
    const mask = Buffer.from([0, 0, 0, 0, 255, 255, 255, 0]);

    assert.deepEqual([...premultipliedIconPixels(color, mask)!], [200, 100, 50, 255, 0, 0, 0, 0]);
  });

  it("gives up on alpha-less icons without a usable mask", () => {
    assert.isUndefined(premultipliedIconPixels(Buffer.from([1, 2, 3, 0]), undefined));
    assert.isUndefined(premultipliedIconPixels(Buffer.from([1, 2, 3, 0]), Buffer.alloc(8)));
  });
});

describe("appIconBitmapWithApi", () => {
  const EXECUTABLE_ICON = 9n;
  const CLASS_ICON = 7n;

  function fakeApi(overrides: Partial<WindowsIconApi> = {}) {
    const deleted: Array<bigint> = [];
    const destroyed: Array<bigint> = [];
    const api: WindowsIconApi = {
      executableIcon: () => EXECUTABLE_ICON,
      windowIcon: () => 0n,
      classIcon: (_, index) => (index === -14 ? CLASS_ICON : 0n),
      iconBitmaps: (icon) =>
        icon === EXECUTABLE_ICON
          ? { color: 90n, mask: 0n }
          : icon === CLASS_ICON
            ? { color: 70n, mask: 71n }
            : undefined,
      bitmapSize: () => ({ width: 1, height: 1 }),
      bitmapPixels: (bitmap) =>
        bitmap === 90n
          ? Buffer.from([9, 9, 9, 255])
          : bitmap === 70n
            ? Buffer.from([1, 2, 3, 255])
            : Buffer.from([0, 0, 0, 0]),
      deleteObject: (object) => {
        deleted.push(object);
      },
      destroyIcon: (icon) => {
        destroyed.push(icon);
      },
      ...overrides,
    };
    return { api, deleted, destroyed };
  }

  it("prefers the executable icon and destroys the extracted handle", () => {
    const { api, deleted, destroyed } = fakeApi();

    const bitmap = appIconBitmapWithApi("C:\\App\\app.exe", 42n, api);

    assert.deepEqual(bitmap, { width: 1, height: 1, pixels: Buffer.from([9, 9, 9, 255]) });
    assert.deepEqual(destroyed, [EXECUTABLE_ICON]);
    assert.deepEqual(deleted, [90n]);
  });

  it("falls back to the window's own icon and releases both GDI bitmaps", () => {
    const { api, deleted, destroyed } = fakeApi({ executableIcon: () => 0n });

    const bitmap = appIconBitmapWithApi("C:\\App\\app.exe", 42n, api);

    assert.deepEqual(bitmap, { width: 1, height: 1, pixels: Buffer.from([1, 2, 3, 255]) });
    assert.deepEqual(deleted, [70n, 71n]);
    assert.deepEqual(destroyed, []);
  });

  it("skips the executable lookup without a path", () => {
    let executableLookups = 0;
    const { api } = fakeApi({
      executableIcon: () => {
        executableLookups++;
        return EXECUTABLE_ICON;
      },
    });

    const bitmap = appIconBitmapWithApi(undefined, 42n, api);

    assert.strictEqual(executableLookups, 0);
    assert.deepEqual(bitmap?.pixels, Buffer.from([1, 2, 3, 255]));
  });

  it("returns nothing for windows without an icon", () => {
    const { api } = fakeApi({ executableIcon: () => 0n, classIcon: () => 0n });

    assert.isUndefined(appIconBitmapWithApi(undefined, 42n, api));
  });

  it("skips monochrome icons but still releases their mask", () => {
    const { api, deleted } = fakeApi({
      executableIcon: () => 0n,
      iconBitmaps: () => ({ color: 0n, mask: 71n }),
    });

    assert.isUndefined(appIconBitmapWithApi(undefined, 42n, api));
    assert.deepEqual(deleted, [71n]);
  });
});
