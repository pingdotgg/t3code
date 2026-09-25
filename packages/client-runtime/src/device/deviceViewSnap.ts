import { Quaternion, Vector3 } from "three";
const y = new Vector3(0, 1, 0);

/** Each useful view permits a small yaw. Pick the closest member of each family, then the closest family. */
export function nearestDeviceView<T extends { rotation: Quaternion; yawLimit: number }>(
  rotation: Quaternion,
  snaps: readonly T[],
) {
  let closest: T | null = null;
  let distance = Infinity;
  for (const snap of snaps) {
    const relative = rotation.clone().multiply(snap.rotation.clone().invert());
    const turn = 2 * Math.atan2(relative.y, relative.w);
    const yaw = Math.max(
      -snap.yawLimit,
      Math.min(snap.yawLimit, Math.atan2(Math.sin(turn), Math.cos(turn))),
    );
    const candidate = snap.rotation.clone().premultiply(new Quaternion().setFromAxisAngle(y, yaw));
    const nextDistance = candidate.angleTo(rotation);
    if (nextDistance < distance - 1e-8) {
      distance = nextDistance;
      closest = { ...snap, rotation: candidate };
    }
  }
  return closest;
}
