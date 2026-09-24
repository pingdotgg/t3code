import { Box3, PerspectiveCamera, Texture, Vector3 } from "three";
import { describe, expect, it } from "vite-plus/test";
import { createPhoneScene, phoneDisplayLayout } from "./phoneScene.ts";
import { IOS_TABLET_SHAPE, IOS_PHONE_SHAPE, ANDROID_PHONE_SHAPE } from "./shapeProfile.ts";

const orientations = [
  "portrait",
  "landscape_left",
  "landscape_right",
  "portrait_upside_down",
] as const;

describe("3D phone input", () => {
  it.each([IOS_TABLET_SHAPE, IOS_PHONE_SHAPE, ANDROID_PHONE_SHAPE])(
    "preserves input projection for the $id silhouette in every orientation",
    (profile) => {
      for (const orientation of orientations) {
        const texture = new Texture();
        const aspect = profile.id === "ios-tablet" ? 0.75 : 0.45;
        const layout = phoneDisplayLayout(
          { width: 1200 * aspect, height: 1200, orientation },
          1200 * aspect,
          1200,
        );
        const phone = createPhoneScene(texture, layout, profile);
        const camera = new PerspectiveCamera(32, 1, 0.1, 30);
        camera.position.z = 6;
        camera.updateMatrixWorld(true);
        phone.root.rotation.set(0.2, -0.3, 0, "YXZ");
        phone.orientation.rotation.z = layout.rotation;
        phone.root.updateMatrixWorld(true);
        const point = new Vector3((-2.2 * aspect) / 4, -2.2 / 4, 0.043);
        phone.orientation.localToWorld(point);
        point.project(camera);
        const hit = phone.screenPoint((point.x + 1) / 2, (1 - point.y) / 2, camera);
        const expected =
          orientation === "landscape_left"
            ? { x: 0.25, y: 0.25 }
            : orientation === "landscape_right"
              ? { x: 0.75, y: 0.75 }
              : orientation === "portrait_upside_down"
                ? { x: 0.75, y: 0.25 }
                : { x: 0.25, y: 0.75 };
        expect(hit?.x).toBeCloseTo(expected.x);
        expect(hit?.y).toBeCloseTo(expected.y);
        phone.dispose();
        texture.dispose();
      }
    },
  );
  it.each([0.6, 2.2])("keeps device coordinates accurate at %s camera zoom", (zoom) => {
    const texture = new Texture();
    const layout = phoneDisplayLayout(null, 900, 1950);
    const phone = createPhoneScene(texture, layout);
    const camera = new PerspectiveCamera(32, 0.65, 0.1, 30);
    camera.position.z = 6 / zoom;
    camera.updateMatrixWorld(true);
    phone.root.rotation.set(0.2, -0.3, 0, "YXZ");
    phone.root.updateMatrixWorld(true);
    const point = new Vector3((-2.2 * layout.aspect) / 4, -2.2 / 4, 0.043);
    phone.orientation.localToWorld(point);
    point.project(camera);
    const hit = phone.screenPoint((point.x + 1) / 2, (1 - point.y) / 2, camera);
    expect(hit?.x).toBeCloseTo(0.25);
    expect(hit?.y).toBeCloseTo(0.75);
    phone.dispose();
    texture.dispose();
  });

  it.each(orientations)("maps perspective hits to displayed coordinates in %s", (orientation) => {
    const texture = new Texture();
    const layout = phoneDisplayLayout({ width: 1170, height: 2532, orientation }, 1170, 2532);
    const phone = createPhoneScene(texture, layout);
    const camera = new PerspectiveCamera(32, 0.65, 0.1, 30);
    camera.position.z = 6;
    camera.updateMatrixWorld(true);
    phone.root.rotation.set(0.3, -0.45, 0, "YXZ");
    phone.orientation.rotation.z = layout.rotation;
    phone.root.updateMatrixWorld(true);
    // A point one quarter across and three quarters down the portrait display.
    const point = new Vector3((-2.2 * layout.aspect) / 4, -2.2 / 4, 0.043);
    phone.orientation.localToWorld(point);
    point.project(camera);
    const hit = phone.screenPoint((point.x + 1) / 2, (1 - point.y) / 2, camera);
    const expected =
      orientation === "landscape_left"
        ? { x: 0.25, y: 0.25 }
        : orientation === "landscape_right"
          ? { x: 0.75, y: 0.75 }
          : orientation === "portrait_upside_down"
            ? { x: 0.75, y: 0.25 }
            : { x: 0.25, y: 0.75 };
    expect(hit?.x).toBeCloseTo(expected.x);
    expect(hit?.y).toBeCloseTo(expected.y);
    phone.dispose();
    texture.dispose();
  });

  it("rejects new gestures outside the display, but clamps captured drags at its edge", () => {
    const texture = new Texture();
    const phone = createPhoneScene(texture, phoneDisplayLayout(null, 900, 1950));
    const camera = new PerspectiveCamera(32, 1, 0.1, 30);
    camera.position.z = 5;
    expect(phone.screenPoint(1, 0.5, camera)).toBeNull();
    expect(phone.screenPoint(1, 0.5, camera, true)).toEqual({ x: 1, y: 0.5 });
    phone.root.rotation.y = Math.PI;
    expect(phone.screenPoint(0.5, 0.5, camera)).toBeNull();
    phone.dispose();
    texture.dispose();
  });

  it.each(["landscape_left", "landscape_right"] as const)(
    "unrotates an already-landscape framebuffer in %s",
    (orientation) => {
      const texture = new Texture();
      const layout = phoneDisplayLayout({ width: 1950, height: 900, orientation }, 1950, 900);
      const phone = createPhoneScene(texture, layout);
      phone.orientation.rotation.z = layout.rotation;
      const camera = new PerspectiveCamera(32, 1, 0.1, 30);
      camera.position.z = 5;
      expect(phone.screenPoint(0.5, 0.5, camera)).toEqual({ x: 0.5, y: 0.5 });
      phone.dispose();
      texture.dispose();
    },
  );
});

it.each([IOS_PHONE_SHAPE, IOS_TABLET_SHAPE, ANDROID_PHONE_SHAPE])(
  "attaches the $id rear camera plate to the back and seats its lenses on the housing",
  (profile) => {
    const texture = new Texture();
    const phone = createPhoneScene(texture, phoneDisplayLayout(null, 900, 1950), profile);
    phone.root.updateMatrixWorld(true);
    const back = new Box3().setFromObject(phone.root.getObjectByName("device-back")!);
    const plate = new Box3().setFromObject(phone.root.getObjectByName("camera-plate")!);
    expect(plate.min.z).toBeLessThan(back.min.z);
    expect(plate.max.z).toBeGreaterThanOrEqual(back.min.z);
    const assembly = phone.root.getObjectByName("rear-camera")!;
    const rings = assembly.children.filter((part) => part.name === "camera-ring");
    const lenses = assembly.children.filter((part) => part.name === "camera-lens");
    for (const [index, ring] of rings.entries()) {
      const ringBounds = new Box3().setFromObject(ring);
      expect(ringBounds.intersectsBox(plate)).toBe(true);
      const lensBounds = new Box3().setFromObject(lenses[index]!);
      expect(Math.abs(lensBounds.max.z - ringBounds.min.z)).toBeLessThan(0.001);
    }
    phone.dispose();
    texture.dispose();
  },
);
