import { Matrix4, Quaternion, Vector3 } from "three";
import { nearestDeviceView } from "./deviceViewSnap.ts";
import type { DeviceScreenSize } from "./stream.ts";

export type DuoRestFace = "cover" | "inside" | "left" | "right";
export type DuoRestFrame = { face: DuoRestFace; normal: Vector3; up: Vector3; center: Vector3 };
export type DuoViewSnap = {
  rotation: Quaternion;
  face: DuoRestFace;
  orientation: DeviceScreenSize["orientation"];
  center: Vector3;
  yawLimit: number;
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
      // Only these rolls put the partner below the focused lid. Other quarter
      // turns belong to the upright, whole-display family.
      if (frame.face === "right" && index !== 0) continue;
      if (frame.face === "left" && index !== 2) continue;
      const roll = (panel === 3 ? Math.PI / 2 : 0) - (index * Math.PI) / 2;
      const rotation = faceRotation.clone().premultiply(new Quaternion().setFromAxisAngle(z, roll));
      // A leaf-focused view looks slightly down onto its partner, as in a seated laptop.
      if (frame.face === "left" || frame.face === "right")
        rotation.premultiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 12));
      if (
        panel === 3 &&
        frames.some(
          (leaf) =>
            (leaf.face === "left" || leaf.face === "right") &&
            leaf.normal.clone().applyQuaternion(rotation).z < 0.04,
        )
      )
        continue;
      // Bound yaw using both real leaf normals. A narrow fold cannot tolerate
      // the same side view as a fully open display.
      let yawLimit = frame.face === "cover" ? Math.PI / 9 : Math.PI / 3;
      if (panel === 3) {
        for (const sign of [-1, 1]) {
          for (let step = 1; step <= 60; step++) {
            const turn = new Quaternion().setFromAxisAngle(y, (sign * step * Math.PI) / 180);
            if (
              frames.some(
                (leaf) =>
                  (leaf.face === "left" || leaf.face === "right") &&
                  leaf.normal.clone().applyQuaternion(rotation).applyQuaternion(turn).z < 0.04,
              )
            ) {
              yawLimit = Math.min(yawLimit, ((step - 1) * Math.PI) / 180);
              break;
            }
          }
        }
      }
      snaps.push({
        rotation,
        face: frame.face,
        orientation: orientations[index]!,
        center: frame.center.clone(),
        yawLimit,
      });
    }
  }
  return snaps;
}

/** Fold-specific candidates use the base viewer's nearest-family selection. */
export const nearestDuoView = nearestDeviceView<DuoViewSnap>;
