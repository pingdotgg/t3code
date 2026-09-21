import { Matrix4, Quaternion, Vector3 } from "three";
import type { DeviceScreenSize } from "./stream.ts";

export type DuoRestFace = "cover" | "inside" | "left" | "right";
export type DuoRestFrame = { face: DuoRestFace; normal: Vector3; up: Vector3; center: Vector3 };
export type DuoViewSnap = {
  rotation: Quaternion;
  face: DuoRestFace;
  orientation: DeviceScreenSize["orientation"];
  center: Vector3;
};
const orientations = [
  "portrait",
  "landscape_left",
  "portrait_upside_down",
  "landscape_right",
] as const;
const z = new Vector3(0, 0, 1);
const y = new Vector3(0, 1, 0);

/** Build views from the actual hinged display planes, rather than model-specific Euler offsets. */
export function duoViewSnaps(frames: readonly DuoRestFrame[], panel: 1 | 3) {
  const snaps: DuoViewSnap[] = [];
  for (const frame of frames) {
    const normal = frame.normal.clone().normalize();
    if (normal.lengthSq() < 0.5) continue;
    const right = frame.up.clone().cross(normal).normalize();
    const up = normal.clone().cross(right).normalize();
    const faceRotation = new Quaternion()
      .setFromRotationMatrix(new Matrix4().makeBasis(right, up, normal))
      .invert();
    for (let index = 0; index < orientations.length; index++) {
      const roll = (panel === 3 ? Math.PI / 2 : 0) - (index * Math.PI) / 2;
      const rotation = faceRotation.clone().premultiply(new Quaternion().setFromAxisAngle(z, roll));
      // A leaf-focused view looks slightly down onto its partner, as in a seated laptop.
      if (frame.face === "left" || frame.face === "right")
        rotation.premultiply(
          new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 12),
        );
      snaps.push({
        rotation,
        face: frame.face,
        orientation: orientations[index]!,
        center: frame.center.clone(),
      });
    }
  }
  return snaps;
}

/** Each useful view permits a small yaw. Pick the closest member of each family, then the closest family. */
export function nearestDuoView(rotation: Quaternion, snaps: readonly DuoViewSnap[]) {
  let closest: DuoViewSnap | null = null;
  let distance = Infinity;
  for (const snap of snaps) {
    const relative = rotation.clone().multiply(snap.rotation.clone().invert());
    const turn = 2 * Math.atan2(relative.y, relative.w);
    const yaw = Math.max(
      -Math.PI / 3,
      Math.min(Math.PI / 3, Math.atan2(Math.sin(turn), Math.cos(turn))),
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
