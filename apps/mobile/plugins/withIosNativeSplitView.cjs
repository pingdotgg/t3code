const { withPodfile } = require("expo/config-plugins");

// react-native-screens ships Split's native controllers behind this pod flag.
module.exports = (config) =>
  withPodfile(config, (config) => {
    const setting = "ENV['RNS_GAMMA_ENABLED'] = '1'";
    if (!config.modResults.contents.includes(setting)) {
      config.modResults.contents = `${setting}\n${config.modResults.contents}`;
    }
    return config;
  });
