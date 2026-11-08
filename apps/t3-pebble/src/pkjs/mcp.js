var xhr = require("./xhr.js");
var PROTOCOL = "2025-03-26";
var origin = "",
  token = "",
  session = null,
  protocolVersion = PROTOCOL,
  sequence = 0,
  connecting = false,
  waiting = [],
  metadata = null;

function reset() {
  session = null;
  protocolVersion = PROTOCOL;
  connecting = false;
  waiting = [];
  metadata = null;
}

exports.configure = function (next) {
  origin = String(next.origin || "").replace(/\/+$/, "");
  token = next.token || "";
  reset();
};
exports.reset = reset;

function headers() {
  var result = {
    authorization: "Bearer " + token,
    "content-type": "application/json",
    accept: "application/json, text/event-stream"
  };
  if (session) {
    result["mcp-session-id"] = session;
    result["mcp-protocol-version"] = protocolVersion;
  }
  return result;
}

function payload(text, contentType) {
  if (String(contentType || "").indexOf("text/event-stream") < 0) return text;
  var lines = String(text || "").split("\n");
  for (var i = 0; i < lines.length; i++)
    if (lines[i].indexOf("data:") === 0) return lines[i].slice(5);
  return null;
}

function rpc(method, params, callback) {
  xhr(
    {
      method: "POST",
      url: origin + "/mcp",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: method, params: params }),
      raw: true,
      timeout: 20000
    },
    function (error, text, request) {
      if (error) {
        session = null;
        return callback(error);
      }
      var body = payload(text, request.getResponseHeader("content-type"));
      if (!body) return callback(new Error("Empty T3 response"));
      var response;
      try {
        response = JSON.parse(body);
      } catch (parseError) {
        return callback(parseError);
      }
      if (response.error || (response.result && response.result.isError))
        return callback(new Error("T3 request failed"));
      session = request.getResponseHeader("mcp-session-id") || session;
      callback(null, (response.result && response.result.structuredContent) || response.result);
    }
  );
}

function initialize(callback) {
  rpc(
    "initialize",
    {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "t3-pebble", version: "0.1.0" }
    },
    function (error, initialized) {
      if (error) return callback(error);
      if (initialized && initialized.protocolVersion) protocolVersion = initialized.protocolVersion;
      xhr(
        {
          method: "POST",
          url: origin + "/mcp",
          headers: headers(),
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
          raw: true,
          timeout: 20000
        },
        function (error) {
          if (error) {
            session = null;
            return callback(error);
          }
          callback(null);
        }
      );
    }
  );
}

function connect(callback) {
  if (session) return callback(null);
  waiting.push(callback);
  if (connecting) return;
  connecting = true;
  initialize(function (error) {
    connecting = false;
    var callbacks = waiting;
    waiting = [];
    for (var i = 0; i < callbacks.length; i++) callbacks[i](error);
  });
}

function call(name, args, callback) {
  if (!origin || !token) return callback(new Error("Pair the watch first"));
  connect(function (error) {
    if (error) return callback(error);
    rpc("tools/call", { name: name, arguments: args }, callback);
  });
}

function threadMetadata(callback) {
  if (metadata && metadata.expires > Date.now()) return callback(null, metadata);
  call("t3_environment_read", {}, function (error, environment) {
    if (error) return callback(error);
    var projects = {};
    function page(cursor) {
      call("t3_project_list", { cursor: cursor, limit: 100 }, function (error, result) {
        if (error) return callback(error);
        var list = result.projects || [];
        for (var i = 0; i < list.length; i++) projects[list[i].id] = list[i].workspaceRoot;
        if (result.nextCursor == null) {
          metadata = {
            machine: environment.label || "",
            projects: projects,
            expires: Date.now() + 300000
          };
          return callback(null, metadata);
        }
        page(result.nextCursor);
      });
    }
    page(0);
  });
}

exports.threadMetadata = threadMetadata;

exports.threads = function (cursor, callback) {
  call(
    "t3_thread_list",
    { allProjects: true, limit: 20, cursor: cursor || 0 },
    function (error, page) {
      if (error) return callback(error);
      threadMetadata(function (error, info) {
        if (error) return callback(error);
        var threads = (page.threads || []).map(function (thread) {
          return {
            threadId: thread.threadId,
            title: thread.title,
            updatedAt: thread.updatedAt,
            providerInstanceId: thread.providerInstanceId,
            relationshipToParent: thread.relationshipToParent,
            sideChat: thread.sideChat,
            machine: info.machine,
            directory: info.projects[thread.projectId] || ""
          };
        });
        callback(null, { threads: threads, nextCursor: page.nextCursor });
      });
    }
  );
};

exports.read = function (threadId, callback) {
  call("t3_thread_read", { threadId: threadId, limit: 1 }, function (error, head) {
    if (error) return callback(error);
    var count = head && head.thread ? head.thread.itemCount : 0;
    var afterPosition = Math.max(0, count - 26);
    var args = { threadId: threadId, view: "activity", limit: 25, maxCharsPerItem: 4000 };
    if (afterPosition) args.afterPosition = afterPosition;
    call("t3_thread_read", args, callback);
  });
};

exports.send = function (threadId, message, callback) {
  call("t3_thread_send", { threadId: threadId, message: message, mode: "queue" }, callback);
};

exports.call = call;
