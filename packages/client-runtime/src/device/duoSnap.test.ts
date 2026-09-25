import { expect, it } from "vite-plus/test";
import { Quaternion, Vector3 } from "three";
import { duoViewSnaps, nearestDuoView } from "./duoSnap.ts";

const frames = [
  {
    face: "inside" as const,
    normal: new Vector3(0, 0, 1),
    up: new Vector3(0, 1, 0),
    center: new Vector3(),
  },
];
const rotation = (x: number, y: number, z = 0) =>
  new Quaternion().setFromAxisAngle(new Vector3(x, y, z).normalize(), Math.hypot(x, y, z));

it("chooses a leaf-focused seated view when it is closer than the middle of the fold", () => {
  const leaf = {
    face: "right" as const,
    normal: new Vector3(0.6, 0, 0.8),
    up: new Vector3(0, 1, 0),
    center: new Vector3(1, 0, 0),
  };
  const candidates = duoViewSnaps([...frames, leaf], 3);
  const seat = candidates.find(
    (candidate) => candidate.face === "right" && candidate.orientation === "portrait",
  )!;
  const released = seat.rotation.clone().premultiply(rotation(0.04, 0.05));
  const chosen = nearestDuoView(released, candidates)!;
  expect(chosen.face).toBe("right");
  expect(chosen.orientation).toBe("portrait");
  expect(chosen.center.x).toBe(1);
});

it("a seated view exposes the base, and upright yaw keeps both inner displays facing the camera", () => {
  const folded = [
    frames[0]!,
    ...(["left", "right"] as const).map((face) => ({
      face,
      normal: new Vector3(face === "left" ? Math.SQRT1_2 : -Math.SQRT1_2, 0, Math.SQRT1_2),
      up: new Vector3(0, 1, 0),
      center: new Vector3(face === "left" ? -1 : 1, 0, 0),
    })),
  ];
  const candidates = duoViewSnaps(folded, 3);
  expect(candidates.filter((candidate) => candidate.face === "right")).toHaveLength(1);
  for (const candidate of candidates) {
    for (const frame of folded.slice(1))
      expect(frame.normal.clone().applyQuaternion(candidate.rotation).z).toBeGreaterThan(0.2);
    const side = candidate.rotation.clone().premultiply(rotation(0, 1.5));
    const chosen = nearestDuoView(side, [candidate])!;
    for (const frame of folded.slice(1))
      expect(frame.normal.clone().applyQuaternion(chosen.rotation).z).toBeGreaterThan(0.02);
  }
});
