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
