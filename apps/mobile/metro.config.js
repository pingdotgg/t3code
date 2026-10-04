const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");
module.exports = withUniwindConfig(getDefaultConfig(__dirname), {
  cssEntryFile: "./global.css",
  extraThemes: require("./generated-uniwind-theme-names.json"),
  polyfills: { rem: 14 },
});
