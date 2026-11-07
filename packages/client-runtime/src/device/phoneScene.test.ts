import { PerspectiveCamera, Texture, Vector3 } from "three";
import { describe, expect, it } from "vite-plus/test";
import { createPhoneScene, phoneDisplayLayout } from "./phoneScene.ts";
import {
  IOS_TABLET_SHAPE,
  IOS_PHONE_SHAPE,
  ANDROID_PHONE_SHAPE,
  ROUND_WATCH_SHAPE,
  SQUARE_WATCH_SHAPE,
  type DeviceShapeProfile,
} from "./shapeProfile.ts";

const orientations = [
  "portrait",
  "landscape_left",
  "landscape_right",
  "portrait_upside_down",
] as const;

describe("3D phone input", () => {
  const aspects: Partial<Record<DeviceShapeProfile["id"], number>> = {
    "ios-tablet": 0.75,
    "round-watch": 1,
    "square-watch": 0.84,
  };
  it.each([
    IOS_TABLET_SHAPE,
    IOS_PHONE_SHAPE,
    ANDROID_PHONE_SHAPE,
    ROUND_WATCH_SHAPE,
    SQUARE_WATCH_SHAPE,
  ])("preserves input projection for the $id silhouette in every orientation", (profile) => {
    for (const orientation of orientations) {
      const texture = new Texture();
      const aspect = aspects[profile.id] ?? 0.45;
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
  });
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

  it("starts touches only inside a round watch face, but keeps captured drags", () => {
    const texture = new Texture();
    const layout = phoneDisplayLayout(null, 480, 480);
    const watch = createPhoneScene(texture, layout, ROUND_WATCH_SHAPE);
    const camera = new PerspectiveCamera(32, 1, 0.1, 30);
    camera.position.z = 6;
    camera.updateMatrixWorld(true);
    const project = (x: number, y: number) => {
      const point = watch.orientation.localToWorld(new Vector3(x, y, 0.043)).project(camera);
      return [(point.x + 1) / 2, (1 - point.y) / 2] as const;
    };
    const [rimX, rimY] = project(0.75, 0.75);
    const rim = watch.screenPoint(rimX, rimY, camera);
    expect(rim?.x).toBeCloseTo(1.85 / 2.2);
    expect(rim?.y).toBeCloseTo(1 - 1.85 / 2.2);
    // Inside the square framebuffer, outside the circular glass.
    const [cornerX, cornerY] = project(0.95, 0.95);
    expect(watch.screenPoint(cornerX, cornerY, camera)).toBeNull();
    const dragged = watch.screenPoint(cornerX, cornerY, camera, true);
    expect(dragged?.x).toBeCloseTo(2.05 / 2.2);
    expect(dragged?.y).toBeCloseTo(1 - 2.05 / 2.2);
    watch.dispose();
    texture.dispose();
  });

  it("gives round watches lugs instead of a rear phone camera", () => {
    const texture = new Texture();
    const countLugs = (scene: ReturnType<typeof createPhoneScene>) => {
      let lugs = 0;
      scene.root.traverse((object) => {
        if (object.name === "watch-lug") lugs++;
      });
      return lugs;
    };
    for (const [profile, lugs] of [
      [ROUND_WATCH_SHAPE, 4],
      [SQUARE_WATCH_SHAPE, 0],
    ] as const) {
      const watch = createPhoneScene(texture, phoneDisplayLayout(null, 480, 480), profile);
      expect(watch.root.getObjectByName("rear-camera")).toBeUndefined();
      expect(countLugs(watch)).toBe(lugs);
      watch.dispose();
    }
    const phone = createPhoneScene(texture, phoneDisplayLayout(null, 900, 1950));
    expect(phone.root.getObjectByName("rear-camera")).toBeDefined();
    expect(countLugs(phone)).toBe(0);
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
