import { Box3, PerspectiveCamera, Vector3 } from "three";

/** Frames all bounds corners with padding, including narrow or short viewports. */
export function fitModelCamera(
  camera: PerspectiveCamera,
  bounds: Box3,
  width: number,
  height: number,
) {
  if (width <= 0 || height <= 0 || bounds.isEmpty()) return;
  const center = bounds.getCenter(new Vector3());
  const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 0.001);
  const direction = new Vector3(1, 0.7, 1).normalize();
  camera.position.copy(center).add(direction);
  camera.lookAt(center);
  const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const verticalSlope = Math.tan((camera.fov * Math.PI) / 360) * 0.85;
  const horizontalSlope = verticalSlope * (width / height);
  let distance = radius;
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        const offset = new Vector3(x, y, z).sub(center);
        distance = Math.max(
          distance,
          offset.dot(direction) + Math.abs(offset.dot(right)) / horizontalSlope,
          offset.dot(direction) + Math.abs(offset.dot(up)) / verticalSlope,
        );
      }
    }
  }
  camera.aspect = width / height;
  camera.near = Math.max(radius / 1000, 0.000001);
  camera.far = Math.max(distance * 10, radius * 100);
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}
