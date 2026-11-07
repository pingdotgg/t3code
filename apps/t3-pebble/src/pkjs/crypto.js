var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64url(bytes) {
  var out = "",
    i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      ALPHABET[(n >> 18) & 63] +
      ALPHABET[(n >> 12) & 63] +
      ALPHABET[(n >> 6) & 63] +
      ALPHABET[n & 63];
  }
  if (bytes.length - i === 1) {
    var one = bytes[i] << 16;
    out += ALPHABET[(one >> 18) & 63] + ALPHABET[(one >> 12) & 63];
  } else if (bytes.length - i === 2) {
    var two = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[(two >> 18) & 63] + ALPHABET[(two >> 12) & 63] + ALPHABET[(two >> 6) & 63];
  }
  return out;
}

exports.base64url = base64url;

exports.random = function (length) {
  var bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
};

exports.challenge = function (verifier, callback) {
  crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(function (hash) {
    callback(null, base64url(new Uint8Array(hash)));
  }, callback);
};
