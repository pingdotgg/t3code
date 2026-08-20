export const SCHEME_NEUTRAL_SPLASH_BACKGROUND = "#737373";

export function createSchemeNeutralSplashConfig(image: string) {
  return {
    image,
    resizeMode: "contain" as const,
    backgroundColor: SCHEME_NEUTRAL_SPLASH_BACKGROUND,
    imageWidth: 220,
  };
}
