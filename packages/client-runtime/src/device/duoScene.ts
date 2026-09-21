import {
  Box3,
  BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  Matrix4,
  Plane,
  Raycaster,
  Triangle,
  Vector2,
  Vector3,
  type PerspectiveCamera,
  type Texture,
} from "three";
import type { DuoRestFrame } from "./duoSnap.ts";
import type { DeviceScreenSize } from "./stream.ts";

export type DuoPanelId = 1 | 3;
export type DuoFrameLayout = { width: number; height: number };

/** Hardware mounting is independent of app orientation and the model's orbit. The inverse is shared by taps and drags. */
export function duoRawPoint(panel: DuoPanelId, x: number, y: number) {
  return panel === 1 ? { x, y } : { x: y, y: 1 - x };
}
export function duoFrameMatches(frame: DuoFrameLayout, screen: DeviceScreenSize) {
  return (
    frame.width > 0 &&
    frame.height > 0 &&
    Math.abs(frame.width / frame.height - screen.width / screen.height) <=
      1 / frame.height + 1 / screen.height
  );
}
export function duoDisplayKey(screen: DeviceScreenSize | null) {
  return screen ? `${screen.screenId}:${screen.width}:${screen.height}:${screen.orientation}` : "";
}

/** Asset resources belong to its model slot; this scene owns only live-screen replacement materials. */
export function createDuoScene(asset: Group, textures: Record<DuoPanelId, Texture>) {
  const left = asset.getObjectByName("left-half");
  const right = asset.getObjectByName("right-half");
  const cover = asset.getObjectByName("cover-display");
  const innerLeft = asset.getObjectByName("inner-display-left");
  const innerRight = asset.getObjectByName("inner-display-right");
  if (
    !left ||
    !right ||
    !(cover instanceof Mesh) ||
    !(innerLeft instanceof Mesh) ||
    !(innerRight instanceof Mesh)
  )
    throw new Error("Duo model must have two hinge groups and all three display meshes");
  const surfaces = { 1: [cover], 3: [innerLeft, innerRight] };
  const boundsByPanel = ([1, 3] as const).map((id) => {
    const bounds = new Box3();
    for (const mesh of surfaces[id]) {
      mesh.geometry.computeBoundingBox();
      bounds.union(mesh.geometry.boundingBox!);
    }
    const size = bounds.getSize(new Vector3());
    if (![size.x, size.y].every((value) => Number.isFinite(value) && value > 0))
      throw new Error("Invalid Duo display bounds");
    return { bounds, size };
  });
  const root = new Group();
  const content = new Group();
  content.add(asset);
  root.add(content);
  let currentAngle = Number.NaN;
  const localBounds = new Box3();
  const relative = new Matrix4();
  const inverse = new Matrix4();
  const materials = {
    1: new MeshBasicMaterial({ map: textures[1], toneMapped: false }),
    3: new MeshBasicMaterial({ map: textures[3], toneMapped: false }),
  };
  const originals = new Map<Mesh, Mesh["material"]>();
  // The two inner meshes sample halves of one framebuffer. Cover UVs face outward on the rear leaf.
  for (const id of [1, 3] as const) {
    const { bounds, size } = boundsByPanel[id === 1 ? 0 : 1]!;
    for (const mesh of surfaces[id]) {
      const position = mesh.geometry.getAttribute("position");
      const uv = new Float32Array(position.count * 2);
      for (let i = 0; i < position.count; i++) {
        const x = (position.getX(i) - bounds.min.x) / size.x;
        uv[i * 2] = id === 1 ? 1 - x : x;
        uv[i * 2 + 1] = (position.getY(i) - bounds.min.y) / size.y;
      }
      mesh.geometry.setAttribute("uv", new BufferAttribute(uv, 2));
      originals.set(mesh, mesh.material);
      mesh.material = materials[id];
    }
  }
  const ray = new Raycaster();
  let captured: {
    panel: DuoPanelId;
    plane: Plane;
    triangle: Triangle;
    uv: [Vector2, Vector2, Vector2];
    key: string;
  } | null = null;
  return {
    root,
    setAngle(angle: number) {
      if (angle === currentAngle) return;
      currentAngle = angle;
      const radians = ((180 - Math.min(180, Math.max(0, angle))) * Math.PI) / 360;
      left.rotation.y = radians;
      right.rotation.y = -radians;
      // Orbit the folded body's center, while retaining the authored hinge pivots.
      content.position.set(0, 0, 0);
      root.updateWorldMatrix(true, true);
      inverse.copy(root.matrixWorld).invert();
      localBounds.makeEmpty();
      asset.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
        if (!object.geometry.boundingBox) return;
        relative.multiplyMatrices(inverse, object.matrixWorld);
        localBounds.union(object.geometry.boundingBox.clone().applyMatrix4(relative));
      });
      content.position.copy(localBounds.getCenter(new Vector3())).negate();
    },
    restFrames(panel: DuoPanelId): DuoRestFrame[] {
      root.updateWorldMatrix(true, true);
      inverse.copy(root.matrixWorld).invert();
      const frame = (meshes: Mesh[], face: DuoRestFrame["face"]): DuoRestFrame => {
        const bounds = new Box3();
        const normal = new Vector3();
        const up = new Vector3();
        for (const mesh of meshes) {
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
          relative.multiplyMatrices(inverse, mesh.matrixWorld);
          bounds.union(mesh.geometry.boundingBox!.clone().applyMatrix4(relative));
          normal.add(
            new Vector3()
              .fromBufferAttribute(mesh.geometry.getAttribute("normal"), 0)
              .transformDirection(relative),
          );
          up.add(new Vector3(0, 1, 0).transformDirection(relative));
        }
        return {
          face,
          center: bounds.getCenter(new Vector3()),
          normal: normal.normalize(),
          up: up.normalize(),
        };
      };
      if (panel === 1) return [frame([cover], "cover")];
      const inside = frame([innerLeft, innerRight], "inside");
      // Leaf views only make sense when both displays form a useful open fold.
      return currentAngle > 20 && currentAngle < 165
        ? [inside, frame([innerLeft], "left"), frame([innerRight], "right")]
        : [inside];
    },
    containsDevice(x: number, y: number, camera: PerspectiveCamera) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      root.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      ray.setFromCamera(new Vector2(x * 2 - 1, 1 - y * 2), camera);
      return ray.intersectObject(root, true).length > 0;
    },
    cancelInput() {
      captured = null;
    },
    screenPoint(
      x: number,
      y: number,
      camera: PerspectiveCamera,
      screen: DeviceScreenSize | null,
      readyKey: string,
      extend = false,
    ) {
      const key = duoDisplayKey(screen);
      if (!screen || !readyKey || key !== readyKey) {
        captured = null;
        return null;
      }
      root.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      ray.setFromCamera(new Vector2(x * 2 - 1, 1 - y * 2), camera);
      if (extend && captured?.key === key) {
        const point = ray.ray.intersectPlane(captured.plane, new Vector3());
        const bary = point ? captured.triangle.getBarycoord(point, new Vector3()) : null;
        if (!bary) return null;
        const uv = captured.uv[0]
          .clone()
          .multiplyScalar(bary.x)
          .addScaledVector(captured.uv[1], bary.y)
          .addScaledVector(captured.uv[2], bary.z);
        return duoRawPoint(captured.panel, uv.x, 1 - uv.y);
      }
      // The chassis occludes rear displays. Only the first visible hit can own a contact.
      const hit = ray.intersectObject(root, true)[0];
      if (!hit?.uv || !hit.face || !(hit.object instanceof Mesh)) return null;
      const panel: DuoPanelId | null = surfaces[1].includes(hit.object)
        ? 1
        : surfaces[3].includes(hit.object)
          ? 3
          : null;
      if (!panel || panel !== screen.screenId) return null;
      const indices = [hit.face.a, hit.face.b, hit.face.c] as const;
      const positions = hit.object.geometry.getAttribute("position");
      const triangle = new Triangle(
        ...(indices.map((index) =>
          new Vector3().fromBufferAttribute(positions, index).applyMatrix4(hit.object.matrixWorld),
        ) as [Vector3, Vector3, Vector3]),
      );
      const hitUvs = hit.object.geometry.getAttribute("uv");
      const uv = indices.map((index) => new Vector2().fromBufferAttribute(hitUvs, index)) as [
        Vector2,
        Vector2,
        Vector2,
      ];
      captured = { panel, triangle, uv, plane: triangle.getPlane(new Plane()), key };
      return duoRawPoint(panel, hit.uv.x, 1 - hit.uv.y);
    },
    dispose() {
      for (const [mesh, material] of originals) mesh.material = material;
      for (const material of Object.values(materials)) {
        material.map = null;
        material.dispose();
      }
      content.remove(asset);
      captured = null;
    },
  };
}
