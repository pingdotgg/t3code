const { withGradleProperties } = require("expo/config-plugins");

// Expo's 2GB heap exhausts memory during :app:mergeExtDexDebug.
const JVM_ARGS = "-Xmx4096m -XX:MaxMetaspaceSize=1024m";

module.exports = function withAndroidGradleHeap(config) {
  return withGradleProperties(config, (nextConfig) => {
    const properties = nextConfig.modResults.filter(
      (item) => !(item.type === "property" && item.key === "org.gradle.jvmargs"),
    );

    properties.push({
      type: "property",
      key: "org.gradle.jvmargs",
      value: JVM_ARGS,
    });

    nextConfig.modResults = properties;
    return nextConfig;
  });
};
