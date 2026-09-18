/** Stable Railway project name for live tests. Tiny module so Function
 * fixtures can share it without pulling distilled into the canvas bundle. */
export const SUITE_PROJECT_NAME =
  process.env.RAILWAY_TEST_PROJECT_NAME || "alchsuite-testlive";
