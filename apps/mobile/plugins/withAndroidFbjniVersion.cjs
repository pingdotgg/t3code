const { withProjectBuildGradle } = require("expo/config-plugins");

// react-native-shiki-engine 0.3.12 asks for `com.facebook.fbjni:fbjni:+`, which Gradle
// resolves to the newest release on Maven Central. That is now 0.8.x, built
// with NDK 28, while React Native links the NDK 27.1 C++ runtime and requires
// 0.7.0. The two disagree on libc++, so the app dies in
// ReactNativeFeatureFlagsCxxInterop's static initializer before any JavaScript
// runs ("cannot locate symbol __cxa_init_primary_exception").
//
// Keep this equal to `fbjni` in react-native/gradle/libs.versions.toml, and move
// it with React Native. withAndroidFbjniVersion.test.mjs fails when they differ.
const FBJNI_VERSION = "0.7.0";
const MARKER = "withAndroidFbjniVersion";

const BLOCKS = {
  groovy: `
// Added by ${MARKER}: keep fbjni on the version React Native ships against.
allprojects {
  configurations.all {
    resolutionStrategy.force 'com.facebook.fbjni:fbjni:${FBJNI_VERSION}'
  }
}
`,
  kt: `
// Added by ${MARKER}: keep fbjni on the version React Native ships against.
allprojects {
  configurations.all {
    resolutionStrategy.force("com.facebook.fbjni:fbjni:${FBJNI_VERSION}")
  }
}
`,
};

module.exports = function withAndroidFbjniVersion(config) {
  return withProjectBuildGradle(config, (nextConfig) => {
    const { contents, language } = nextConfig.modResults;
    const block = BLOCKS[language];
    if (block === undefined) {
      throw new Error(`${MARKER}: unsupported root build.gradle language "${language}".`);
    }
    if (!contents.includes(MARKER)) {
      nextConfig.modResults.contents = `${contents.trimEnd()}\n${block}`;
    }
    return nextConfig;
  });
};
