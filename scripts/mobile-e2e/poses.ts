export interface Pose {
  readonly id: string;
  readonly platform: "ios" | "android";
  /** A model name from the pool's catalog (`GET /v1/catalog`). */
  readonly device: string;
  readonly form: "phone" | "tablet";
  readonly appearance: "light" | "dark";
  /** Phones are portrait-only; tablets also run rotated. */
  readonly landscape?: boolean;
  readonly fold?: "closed" | "open";
  readonly textSize?: "accessibility-large";
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
    id: "iphone-13-mini-dark",
    platform: "ios",
    device: "iPhone 13 mini",
    form: "phone",
    appearance: "dark",
  }),
  pose({
    id: "iphone-17-pro",
    platform: "ios",
    device: "iPhone 17 Pro",
    form: "phone",
    appearance: "light",
  }),
  pose({
    id: "iphone-17-pro-max-large-text",
    platform: "ios",
    device: "iPhone 17 Pro Max",
    form: "phone",
    appearance: "dark",
    textSize: "accessibility-large",
  }),
  pose({
    id: "ipad-mini",
    platform: "ios",
    device: "iPad mini (A17 Pro)",
    form: "tablet",
    appearance: "light",
  }),
  pose({
    id: "ipad-pro-13-landscape",
    platform: "ios",
    device: "iPad Pro 13-inch (M5)",
    form: "tablet",
    appearance: "dark",
    landscape: true,
  }),
  pose({
    id: "pixel-9",
    platform: "android",
    device: "Pixel 9",
    form: "phone",
    appearance: "light",
  }),
  pose({
    id: "small-phone-dark",
    platform: "android",
    device: "Small Phone",
    form: "phone",
    appearance: "dark",
  }),
  pose({
    id: "pixel-9-large-text",
    platform: "android",
    device: "Pixel 9",
    form: "phone",
    appearance: "light",
    textSize: "accessibility-large",
  }),
  pose({
    id: "pixel-fold-closed",
    platform: "android",
    device: "Pixel 9 Pro Fold",
    form: "phone",
    appearance: "light",
    fold: "closed",
  }),
  pose({
    id: "pixel-fold-open",
    platform: "android",
    device: "Pixel 9 Pro Fold",
    form: "tablet",
    appearance: "dark",
    fold: "open",
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
