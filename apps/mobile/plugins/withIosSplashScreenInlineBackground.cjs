const { withMod } = require("expo/config-plugins");

function inlineSplashScreenBackground(modResults) {
  // Expo's splashScreenStoryboard modResults is the parsed XML root, whose
  // top-level `document` property contains the storyboard document.
  const document = modResults.document;
  const mainView = document.scenes?.[0]?.scene?.[0]?.objects?.[0]?.viewController?.[0]?.view?.[0];
  const namedBackground = document.resources?.[0]?.namedColor?.find(
    (entry) => entry.$?.name === "SplashScreenBackground",
  );
  const backgroundReference = mainView?.color?.find((entry) => entry.$?.key === "backgroundColor");
  const concreteColor = namedBackground?.color?.[0]?.$;

  if (backgroundReference?.$?.name !== "SplashScreenBackground" || !concreteColor) {
    throw new Error(
      "Could not find Expo's generated splash background in SplashScreen.storyboard.",
    );
  }

  mainView.color = [{ $: { key: "backgroundColor", ...concreteColor } }];
  return modResults;
}

module.exports = function withIosSplashScreenInlineBackground(config) {
  return withMod(config, {
    platform: "ios",
    mod: "splashScreenStoryboard",
    action: async (nextConfig) => {
      nextConfig.modResults = inlineSplashScreenBackground(nextConfig.modResults);
      return nextConfig;
    },
  });
};

module.exports.inlineSplashScreenBackground = inlineSplashScreenBackground;
