// Callback XHR wrapper: Android and iOS WebViews both support it, and PebbleKit JS has no fetch.
module.exports = function request(options, callback) {
  var xhr = new XMLHttpRequest();
  var finished = false;
  function finish(error, data) {
    if (finished) return;
    finished = true;
    callback(error, data, xhr);
  }
  xhr.open(options.method || "GET", options.url, true);
  if (options.timeout) xhr.timeout = options.timeout;
  if (options.responseType) xhr.responseType = options.responseType;
  var headers = options.headers || {};
  for (var name in headers) if (headers[name]) xhr.setRequestHeader(name, headers[name]);
  xhr.onload = function () {
    if (xhr.status < 200 || xhr.status >= 300) return finish(new Error("HTTP " + xhr.status));
    if (options.responseType === "arraybuffer") return finish(null, xhr.response);
    if (options.raw) return finish(null, xhr.responseText);
    var data;
    try {
      data = JSON.parse(xhr.responseText);
    } catch (error) {
      return finish(error);
    }
    finish(null, data);
  };
  xhr.onerror = function () {
    finish(new Error("Connection failed"));
  };
  xhr.ontimeout = function () {
    finish(new Error("Connection timed out"));
  };
  xhr.send(options.body == null ? null : options.body);
};
