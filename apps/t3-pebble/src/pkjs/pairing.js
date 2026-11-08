var xhr = require("./xhr.js");
var crypto = require("./crypto.js");
var REDIRECT = "http://127.0.0.1/callback";

// Accepts the full pairing URL from T3 Code settings, including a nested t3code://pair link.
exports.parse = function (input) {
  var value = String(input || "").trim();
  if (!value || !/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return null;
  try {
    var url = new URL(value);
    if (/^t3code(?:-[a-z]+)?:$/.test(url.protocol) && url.hostname === "pair") {
      var nested = url.searchParams.get("pairingUrl");
      if (!nested) return null;
      url = new URL(nested);
    }
    if (["http:", "https:", "ws:", "wss:"].indexOf(url.protocol) < 0) return null;
    var code = (
      new URLSearchParams(url.hash.slice(1)).get("token") ||
      url.searchParams.get("token") ||
      ""
    ).trim();
    if (!code) return null;
    var origin = url.origin;
    if (url.protocol === "ws:") origin = origin.replace(/^ws:/, "http:");
    if (url.protocol === "wss:") origin = origin.replace(/^wss:/, "https:");
    return { origin: origin, code: code };
  } catch (_error) {
    return null;
  }
};

exports.code = function (input) {
  var parsed = exports.parse(input);
  return parsed ? parsed.code : null;
};

exports.pair = function (origin, pairingCode, callback) {
  var verifier = crypto.random(32);
  crypto.challenge(verifier, function (error, challenge) {
    if (error) return callback(error);
    var state = crypto.random(32);
    var resource = origin + "/mcp";
    function post(path, body, contentType, done) {
      xhr(
        {
          method: "POST",
          url: origin + path,
          headers: { "content-type": contentType },
          body: body,
          timeout: 20000
        },
        done
      );
    }
    var registration = JSON.stringify({
      client_name: "T3 Pebble",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none"
    });
    post("/oauth/mcp/register", registration, "application/json", function (error, client) {
      if (error || !client || !client.client_id)
        return callback(new Error("Pairing failed. Check the code and its permissions."));
      var authorization = {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: state,
        resource: resource
      };
      var decision = {
        authorization: authorization,
        decision: { _tag: "pairing-code", access: "full-access", code: pairingCode }
      };
      post(
        "/oauth/mcp/decision",
        JSON.stringify(decision),
        "application/json",
        function (error, approval) {
          if (error || !approval || !approval.redirectTo)
            return callback(new Error("Pairing failed. Check the code and its permissions."));
          var result;
          try {
            result = new URL(approval.redirectTo);
          } catch (_error) {
            return callback(new Error("Invalid pairing response"));
          }
          if (
            result.origin !== "http://127.0.0.1" ||
            result.pathname !== "/callback" ||
            result.searchParams.get("state") !== state
          )
            return callback(new Error("Invalid pairing response"));
          var code = result.searchParams.get("code");
          if (!code) return callback(new Error("Pairing was not approved"));
          var form =
            "grant_type=authorization_code" +
            "&code=" +
            encodeURIComponent(code) +
            "&redirect_uri=" +
            encodeURIComponent(REDIRECT) +
            "&client_id=" +
            encodeURIComponent(client.client_id) +
            "&code_verifier=" +
            encodeURIComponent(verifier) +
            "&resource=" +
            encodeURIComponent(resource);
          post(
            "/oauth/mcp/token",
            form,
            "application/x-www-form-urlencoded",
            function (error, token) {
              if (error || !token || typeof token.access_token !== "string" || !token.access_token)
                return callback(new Error("Invalid pairing response"));
              callback(null, token.access_token);
            }
          );
        }
      );
    });
  });
};
