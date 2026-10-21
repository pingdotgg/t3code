const { withProjectBuildGradle } = require("expo/config-plugins");

// Match fbjni in react-native/gradle/libs.versions.toml; newer NDK builds can crash RN's libc++ before JS.
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
