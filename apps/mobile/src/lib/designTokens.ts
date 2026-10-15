/** Named shapes belong to components; native controls retain platform geometry. */
export const MOBILE_SHAPE = {
  group: { ios: 24, android: 28 },
  toast: 26,
  glass: 32,
} as const;

/** Finite transitions only; each animation must opt into system reduced motion. */
export const MOBILE_MOTION = { enter: 200, exit: 150 } as const;
