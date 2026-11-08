var WORK = [
  "reasoning",
  "command_execution",
  "file_change",
  "file_read",
  "file_search",
  "web_search",
  "dynamic_tool"
];
var ACTIVE = ["pending", "running", "waiting"];
var JSON_TOOL = /"(?:toolName|name)"\s*:\s*"(read|view_image)"/;

function summary(item) {
  var title = String(item.title || "");
  if (item.type === "command_execution") return title.trim() || "Ran command";
  if (item.type === "reasoning") return title || "Thinking";
  return "";
}

function action(item) {
  if (item.type === "reasoning") return null;
  if (item.requestKind === "file-read" || item.type === "file_read") return "read";
  if (item.type === "command_execution") return "command";
  if (item.type === "file_change") return "edit";
  if (item.type === "file_search") return "code-search";
  var title = String(item.title || "");
  if (item.type === "web_search") return /\bgrep\b/i.test(title) ? "code-search" : "search";
  if (item.type === "dynamic_tool") {
    var name = item.toolName || (JSON_TOOL.exec(item.text || "") || JSON_TOOL.exec(title) || [])[1];
    return name === "read" || name === "view_image" ? "read" : "other";
  }
  return "other";
}

function count(action, items) {
  if (action !== "edit") return items.length;
  var files = {},
    bare = 0;
  for (var i = 0; i < items.length; i++) {
    if (!items[i].changedFiles || !items[i].changedFiles.length) bare++;
    else for (var j = 0; j < items[i].changedFiles.length; j++) files[items[i].changedFiles[j]] = 1;
  }
  return Object.keys(files).length + bare;
}

function label(action, n) {
  var one = n === 1;
  switch (action) {
    case "command":
      return "Ran " + n + (one ? " command" : " commands");
    case "read":
      return "Read " + n + (one ? " file" : " files");
    case "edit":
      return "Changed " + n + (one ? " file" : " files");
    case "search":
      return "Searched the web " + n + (one ? " time" : " times");
    case "code-search":
      return "Searched code " + n + (one ? " time" : " times");
    default:
      return "Used " + n + (one ? " tool" : " tools");
  }
}

function priority(action) {
  if (action === "command" || action === "edit") return 0;
  return action === "other" ? 2 : 1;
}

function join(labels) {
  labels = labels.map(function (text, index) {
    return index ? text.charAt(0).toLowerCase() + text.slice(1) : text;
  });
  if (labels.length < 3) return labels.join(" and ");
  return labels.slice(0, -1).join(", ") + ", and " + labels[labels.length - 1];
}

function groupSummary(items) {
  var tools = items.filter(function (item) {
    return item.type !== "reasoning";
  });
  if (!tools.length) return items.length === 1 ? "Thought" : "Thought (×" + items.length + ")";
  var order = [],
    grouped = {};
  tools.forEach(function (item) {
    var kind = action(item);
    if (!grouped[kind]) {
      grouped[kind] = [];
      order.push(kind);
    }
    grouped[kind].push(item);
  });
  var categories = order.map(function (kind, index) {
    return {
      index: index,
      count: grouped[kind].length,
      priority: priority(kind),
      label: label(kind, count(kind, grouped[kind]))
    };
  });
  var selected = categories
    .slice()
    .sort(function (a, b) {
      return a.priority - b.priority || a.index - b.index;
    })
    .slice(0, 2)
    .sort(function (a, b) {
      return a.index - b.index;
    });
  var labels = selected.map(function (category) {
    return category.label;
  });
  var remaining =
    tools.length -
    selected.reduce(function (total, category) {
      return total + category.count;
    }, 0);
  if (remaining > 0)
    labels.push("Performed " + remaining + " other " + (remaining === 1 ? "action" : "actions"));
  return join(labels);
}

function group(items, format, namespace) {
  var out = [],
    run = [];
  function flush() {
    if (!run.length) return;
    var first = run[0];
    var fallback = namespace && first.position != null ? namespace + "#" + first.position : "";
    out.push({
      type: "work_group",
      text: run
        .map(function (item) {
          return format(item.text || item.title || "", item.type);
        })
        .join("\n\n")
        .slice(0, 900),
      item: first.itemId || fallback,
      summary: groupSummary(run),
      status: "completed"
    });
    run = [];
  }
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (WORK.indexOf(item.type) >= 0 && ACTIVE.indexOf(item.status) < 0) run.push(item);
    else {
      flush();
      out.push(item);
    }
  }
  flush();
  return out;
}

summary.group = group;
module.exports = summary;
