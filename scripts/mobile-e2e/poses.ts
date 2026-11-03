export interface Pose {
  readonly id: string;
  readonly platform: "ios" | "android";
  /** A model name from the pool's catalog (`GET /v1/catalog`). */
  readonly device: string;
  readonly form: "phone" | "tablet";
  readonly appearance: "light" | "dark";
  /** Phones are portrait-locked; tablets and an unfolded Fold can start rotated. */
  readonly landscape?: boolean;
  readonly fold?: "closed" | "open";
  readonly textSize?: "accessibility-large";
  /** Why the pose is skipped unless named with --pose. */
  readonly pending?: string;
}

const pose = (value: Pose) => value;

export const POSES: ReadonlyArray<Pose> = [
  pose({
    id: "iphone-se",
    platform: "ios",
    device: "iPhone SE (3rd generation)",
    form: "phone",
    appearance: "light",
  }),
  pose({
    id: "iphone-18-pro-dark",
    platform: "ios",
    device: "iPhone 18 Pro",
    form: "phone",
    appearance: "dark",
  }),
  pose({
    id: "iphone-duo-folded",
    platform: "ios",
    device: "iPhone Duo",
    form: "phone",
    appearance: "light",
    fold: "closed",
    pending:
      "agent-device alert accept cannot see the iOS open-link prompt on the iPhone Duo, so the app never launches",
  }),
  pose({
    id: "iphone-duo-unfolded",
    platform: "ios",
    device: "iPhone Duo",
    form: "tablet",
    appearance: "dark",
    fold: "open",
    pending:
      "agent-device alert accept cannot see the iOS open-link prompt on the iPhone Duo, so the app never launches",
  }),
  pose({
    id: "ipad-13-portrait",
    platform: "ios",
    device: "iPad Pro 13-inch (M5)",
    form: "tablet",
    appearance: "light",
  }),
  pose({
    id: "ipad-13-landscape-large-text",
    platform: "ios",
    device: "iPad Pro 13-inch (M5)",
    form: "tablet",
    appearance: "dark",
    landscape: true,
    textSize: "accessibility-large",
  }),
  pose({
    id: "pixel-10-pro-large-text",
    platform: "android",
    device: "Pixel 10 Pro",
    form: "phone",
    appearance: "light",
    textSize: "accessibility-large",
  }),
  pose({
    id: "pixel-fold-folded-dark",
    platform: "android",
    device: "Pixel 10 Pro Fold",
    form: "phone",
    appearance: "dark",
    fold: "closed",
  }),
  pose({
    id: "pixel-fold-unfolded",
    platform: "android",
    device: "Pixel 10 Pro Fold",
    form: "tablet",
    appearance: "light",
    fold: "open",
  }),
  pose({
    id: "pixel-fold-unfolded-landscape",
    platform: "android",
    device: "Pixel 10 Pro Fold",
    form: "tablet",
    appearance: "dark",
    fold: "open",
    landscape: true,
  }),
  pose({
    id: "pixel-tablet-portrait",
    platform: "android",
    device: "Pixel Tablet",
    form: "tablet",
    appearance: "dark",
  }),
  pose({
    id: "pixel-tablet-landscape",
    platform: "android",
    device: "Pixel Tablet",
    form: "tablet",
    appearance: "light",
    landscape: true,
  }),
];
