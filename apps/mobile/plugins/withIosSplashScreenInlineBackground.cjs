const { withMod } = require("expo/config-plugins");

module.exports = function withIosSplashScreenInlineBackground(config) {
  return withMod(config, {
    platform: "ios",
    mod: "splashScreenStoryboard",
    action: async (nextConfig) => {
      const document = nextConfig.modResults.document;
      const mainView =
        document.scenes?.[0]?.scene?.[0]?.objects?.[0]?.viewController?.[0]?.view?.[0];
      const namedBackground = document.resources?.[0]?.namedColor?.find(
        (entry) => entry.$?.name === "SplashScreenBackground",
      );
      const backgroundReference = mainView?.color?.find(
        (entry) => entry.$?.key === "backgroundColor",
      );
      const concreteColor = namedBackground?.color?.[0]?.$;

      if (backgroundReference?.$?.name !== "SplashScreenBackground" || !concreteColor) {
        throw new Error(
          "Could not find Expo's generated splash background in SplashScreen.storyboard.",
        );
      }

      mainView.color = [{ $: { key: "backgroundColor", ...concreteColor } }];

      return nextConfig;
    },
  });
};
