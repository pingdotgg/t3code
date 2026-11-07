// Credentials live only in the phone app's localStorage; nothing secret is built into the bundle.
var URL_KEY = "mcpUrl",
  TOKEN_KEY = "mcpToken",
  ELEVEN_KEY = "elevenKey";

function get(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch (_error) {
    return "";
  }
}
function set(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch (_error) {}
}

exports.origin = function () {
  return get(URL_KEY).replace(/\/+$/, "");
};
exports.token = function () {
  return get(TOKEN_KEY);
};
exports.elevenKey = function () {
  return get(ELEVEN_KEY);
};
exports.savePairing = function (origin, token) {
  set(URL_KEY, origin);
  set(TOKEN_KEY, token);
};
exports.saveElevenKey = function (key) {
  set(ELEVEN_KEY, key);
};
