import {
  BoxGeometry,
  CircleGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Plane,
  Raycaster,
  Shape,
  ShapeGeometry,
  Vector2,
  Vector3,
  type Camera,
  type BufferGeometry,
  type Texture,
} from "three";
import type { DeviceScreenSize } from "./stream.ts";
import { IOS_PHONE_SHAPE, type DeviceShapeProfile } from "./shapeProfile.ts";

const SCREEN_HEIGHT = 2.2;

function roundedPath(width: number, height: number, radius: number, path = new Shape()) {
  const x = -width / 2;
  const y = -height / 2;
  path.moveTo(x + radius, y);
  path.lineTo(x + width - radius, y);
  path.quadraticCurveTo(x + width, y, x + width, y + radius);
  path.lineTo(x + width, y + height - radius);
  path.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  path.lineTo(x + radius, y + height);
  path.quadraticCurveTo(x, y + height, x, y + height - radius);
  path.lineTo(x, y + radius);
  path.quadraticCurveTo(x, y, x + radius, y);
  return path;
}

/** Display orientation is independent of orbit. Texture coordinates stay in raw framebuffer space. */
export function phoneDisplayLayout(
  screen: DeviceScreenSize | null,
  rawWidth: number,
  rawHeight: number,
) {
  const width = rawWidth || screen?.width || 900;
  const height = rawHeight || screen?.height || 1950;
  const landscape =
    screen?.orientation === "landscape_left" || screen?.orientation === "landscape_right";
  const rotation =
    screen?.orientation === "landscape_left"
      ? -Math.PI / 2
      : screen?.orientation === "landscape_right"
        ? Math.PI / 2
        : screen?.orientation === "portrait_upside_down"
          ? Math.PI
          : 0;
  return {
    aspect: Math.min(width, height) / Math.max(width, height),
    rotation,
    landscape,
    rawLandscape: width > height,
  };
}

/** An original procedural device body. It makes no claim to reproduce a particular hardware model. */
export function createPhoneScene(
  texture: Texture,
  layout: ReturnType<typeof phoneDisplayLayout>,
  profile: DeviceShapeProfile = IOS_PHONE_SHAPE,
) {
  const { aspect } = layout;
  const root = new Group();
  const orientation = new Group();
  root.add(orientation);
  const screenWidth = SCREEN_HEIGHT * aspect;
  const width = screenWidth + profile.bezel * 2;
  const height = SCREEN_HEIGHT + profile.bezel * 2;
  const backZ = 0.01 - profile.depth;
  const metal = new MeshStandardMaterial({ color: 0xb5bcc7, metalness: 0.88, roughness: 0.27 });
  const glass = new MeshPhysicalMaterial({
    color: 0x141820,
    metalness: 0.15,
    roughness: 0.2,
    clearcoat: 1,
  });
  const backMaterial = new MeshStandardMaterial({
    color: profile.backColor,
    metalness: 0.45,
    roughness: 0.32,
  });
  const lensMaterial = new MeshPhysicalMaterial({
    color: 0x071326,
    metalness: 0.6,
    roughness: 0.12,
    clearcoat: 1,
  });
  const materials = [metal, glass, backMaterial, lensMaterial];

  const body = new Mesh(
    new ExtrudeGeometry(roundedPath(width, height, profile.bodyRadius), {
      depth: profile.depth,
      bevelEnabled: true,
      bevelSize: 0.012,
      bevelThickness: 0.012,
      bevelSegments: 3,
      steps: 1,
      curveSegments: 12,
    }),
    metal,
  );
  body.position.z = 0.025 - profile.depth;
  orientation.add(body);
  const face = new Mesh(
    new ShapeGeometry(roundedPath(width - 0.014, height - 0.014, profile.bodyRadius - 0.01), 16),
    glass,
  );
  face.position.z = 0.04;
  orientation.add(face);
  const back = new Mesh(
    new ShapeGeometry(roundedPath(width - 0.012, height - 0.012, profile.bodyRadius - 0.01), 16),
    backMaterial,
  );
  back.name = "device-back";
  back.rotation.y = Math.PI;
  back.position.z = backZ;
  orientation.add(back);

  const screenGeometry = new ShapeGeometry(
    roundedPath(screenWidth, SCREEN_HEIGHT, profile.screenRadius),
    20,
  );
  updateDisplayUv(screenGeometry, screenWidth, SCREEN_HEIGHT, layout);
  const screenMaterial = new MeshBasicMaterial({ map: texture, toneMapped: false });
  const display = new Mesh(screenGeometry, screenMaterial);
  display.position.z = 0.043;
  orientation.add(display);

  for (const { edge, offset, length } of profile.buttons) {
    const button = new Mesh(
      new BoxGeometry(
        edge === "top" ? length : 0.026,
        edge === "top" ? 0.026 : length,
        profile.depth * 0.65,
      ),
      metal,
    );
    button.position.set(
      edge === "top" ? offset : (edge === "left" ? -1 : 1) * (width / 2 + 0.015),
      edge === "top" ? height / 2 + 0.015 : offset,
      (0.025 + backZ) / 2,
    );
    orientation.add(button);
  }
  // Rear components share a surface-relative coordinate system, with outward positive Z.
  const rearCamera = new Group();
  rearCamera.name = "rear-camera";
  rearCamera.position.set(
    width / 2 - profile.camera.insetX,
    height / 2 - profile.camera.insetY,
    back.position.z + 0.001,
  );
  rearCamera.rotation.y = Math.PI;
  orientation.add(rearCamera);
  const plateFront = 0.025 + 0.007;
  const ringDepth = 0.025;
  const cameraPlate = new Mesh(
    new ExtrudeGeometry(
      roundedPath(
        profile.camera.width,
        profile.camera.height,
        Math.min(profile.camera.width, profile.camera.height) / 4,
      ),
      {
        depth: 0.025,
        bevelEnabled: true,
        bevelSize: 0.009,
        bevelThickness: 0.007,
        bevelSegments: 2,
      },
    ),
    backMaterial,
  );
  cameraPlate.name = "camera-plate";
  rearCamera.add(cameraPlate);
  for (const [x, y] of profile.camera.lenses) {
    const radius = profile.camera.lensRadius;
    const ring = new Mesh(new CylinderGeometry(radius + 0.014, radius + 0.014, 0.025, 32), metal);
    ring.rotation.x = Math.PI / 2;
    ring.name = "camera-ring";
    ring.position.set(x, y, plateFront + ringDepth / 2 - 0.003);
    rearCamera.add(ring);
    const lens = new Mesh(new CircleGeometry(radius, 32), lensMaterial);
    lens.name = "camera-lens";
    lens.position.set(x, y, ring.position.z + ringDepth / 2 + 0.0005);
    rearCamera.add(lens);
  }
  const flashMaterial = new MeshBasicMaterial({ color: 0xf2ead6 });
  if (profile.camera.flash) {
    const flash = new Mesh(new CircleGeometry(0.022, 20), flashMaterial);
    flash.position.set(profile.camera.flash[0], profile.camera.flash[1], plateFront + 0.0005);
    rearCamera.add(flash);
  }

  let activeLayout = layout;
  const screenPoint = createDisplayProjection(
    display,
    orientation,
    screenWidth,
    SCREEN_HEIGHT,
    () => activeLayout,
  );
  return {
    root,
    orientation,
    width,
    height,
    screenPoint,
    setDisplay(nextTexture: Texture, nextLayout: PhoneDisplayLayout) {
      activeLayout = nextLayout;
      screenMaterial.map = nextTexture;
      updateDisplayUv(screenGeometry, screenWidth, SCREEN_HEIGHT, activeLayout);
    },
    dispose() {
      root.traverse((object) => {
        if (object instanceof Mesh) object.geometry.dispose();
      });
      for (const material of materials) material.dispose();
      screenMaterial.dispose();
      flashMaterial.dispose();
    },
  };
}

export type PhoneDisplayLayout = ReturnType<typeof phoneDisplayLayout>;

/** Canonical portrait geometry maps to raw framebuffer coordinates in every OS orientation. */
export function updateDisplayUv(
  geometry: BufferGeometry,
  width: number,
  height: number,
  layout: PhoneDisplayLayout,
) {
  const position = geometry.getAttribute("position");
  if (!geometry.hasAttribute("uv")) {
    geometry.setAttribute(
      "uv",
      new Float32BufferAttribute(new Float32Array(position.count * 2), 2),
    );
  }
  const uv = geometry.getAttribute("uv");
  for (let i = 0; i < position.count; i++) {
    const u = (position.getX(i) + width / 2) / width;
    const v = (position.getY(i) + height / 2) / height;
    uv.setXY(
      i,
      layout.rawLandscape ? (layout.rotation > 0 ? 1 - v : v) : u,
      layout.rawLandscape ? (layout.rotation > 0 ? u : 1 - u) : v,
    );
  }
  uv.needsUpdate = true;
}

/** New touches hit only the front display; captured drags project onto its plane and clamp. */
export function createDisplayProjection(
  display: Mesh,
  orientation: Group,
  width: number,
  height: number,
  getLayout: () => PhoneDisplayLayout,
) {
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const local = new Vector3();
  display.geometry.computeBoundingBox();
  const z = display.position.z + (display.geometry.boundingBox?.max.z ?? 0);
  const plane = new Plane(new Vector3(0, 0, 1), -z);
  return (x: number, y: number, camera: Camera, captured = false) => {
    orientation.updateWorldMatrix(true, true);
    camera.updateMatrixWorld(true);
    pointer.set(x * 2 - 1, 1 - y * 2);
    raycaster.setFromCamera(pointer, camera);
    if (!captured) {
      const hit = raycaster.intersectObject(display, false)[0];
      if (!hit) return null;
      local.copy(hit.point);
      orientation.worldToLocal(local);
    } else {
      const ray = raycaster.ray.clone().applyMatrix4(orientation.matrixWorld.clone().invert());
      if (!ray.intersectPlane(plane, local)) return null;
    }
    const u = Math.min(1, Math.max(0, (local.x + width / 2) / width));
    const v = Math.min(1, Math.max(0, (local.y + height / 2) / height));
    const { rotation } = getLayout();
    if (rotation === -Math.PI / 2) return { x: v, y: u };
    if (rotation === Math.PI / 2) return { x: 1 - v, y: 1 - u };
    if (rotation === Math.PI) return { x: 1 - u, y: v };
    return { x: u, y: 1 - v };
  };
}
