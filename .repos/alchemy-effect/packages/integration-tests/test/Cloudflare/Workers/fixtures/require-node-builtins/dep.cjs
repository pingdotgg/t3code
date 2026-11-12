// A CommonJS dependency that requires Node builtins at module scope — the
// same shape as `pg` (#880). Module evaluation happens during Cloudflare's
// startup validation, which is exactly where the unconverted throwing
// `require` fallback used to crash the Worker.
const { EventEmitter } = require("events");
const util = require("node:util");

const emitter = new EventEmitter();

// Takes its value from the request so the bundler cannot constant-fold the
// round-trip away at build time.
function roundTrip(value) {
  let received = "";
  emitter.once("ping", (v) => {
    received = v;
  });
  emitter.emit("ping", value);
  return util.format("require-node-builtins:%s", received);
}

module.exports = { roundTrip };
