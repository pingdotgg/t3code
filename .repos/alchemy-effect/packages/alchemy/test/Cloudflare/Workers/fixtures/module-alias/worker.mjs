import { createRequire } from "module";
import { createRequire as nodeCreateRequire } from "node:module";
import typescript from "typescript";
import execa from "execa";
import readable from "readable-stream";

const bare = require("module");
const prefixed = require("node:module");
const { EventEmitter } = require("events");
const { format } = require("node:util");

export default {
  fetch() {
    const emitter = new EventEmitter();
    let event;
    emitter.on("value", (value) => {
      event = format("builtin:%s", value);
    });
    emitter.emit("value", "ok");
    return Response.json({
      bare: createRequire(undefined),
      prefixed: nodeCreateRequire(undefined),
      cjsBare: bare.createRequire(undefined),
      cjsPrefixed: prefixed.createRequire(undefined),
      typescript,
      execa,
      readable,
      event,
    });
  },
};
