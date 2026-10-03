const { withProjectBuildGradle } = require("expo/config-plugins");

const FBJNI_FORCE = "resolutionStrategy.force 'com.facebook.fbjni:fbjni:0.7.0'";

module.exports = function withAndroidFbjniVersion(config) {
  return withProjectBuildGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "groovy") {
      throw new Error("withAndroidFbjniVersion: project build.gradle must use Groovy.");
    }

    const contents = nextConfig.modResults.contents;
    if (contents.includes(FBJNI_FORCE)) {
      return nextConfig;
    }

    // react-native 0.86.3 requires fbjni 0.7.0. react-native-shiki-engine
    // requests fbjni:+, whose NDK 28 binary is incompatible with RN's NDK 27
    // libc++ and crashes before JavaScript starts.
    nextConfig.modResults.contents = `${contents.trimEnd()}

allprojects {
  configurations.all {
    ${FBJNI_FORCE}
  }
}
`;

    return nextConfig;
  });
};
