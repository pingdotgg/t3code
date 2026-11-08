var xhr = require("./xhr.js");
var storage = require("./storage.js");
var VOICE = "21m00Tcm4TlvDq8ikWAM";

// No documented on-device PebbleKit JS text-to-speech exists, so speak from the phone directly.
exports.speak = function (text, callback) {
  var key = storage.elevenKey();
  if (!key) return callback(null, null);
  xhr(
    {
      method: "POST",
      url:
        "https://api.elevenlabs.io/v1/text-to-speech/" +
        encodeURIComponent(VOICE) +
        "?output_format=pcm_8000",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        text: String(text || "").slice(0, 4000),
        model_id: "eleven_flash_v2_5"
      }),
      responseType: "arraybuffer",
      timeout: 60000
    },
    callback
  );
};
