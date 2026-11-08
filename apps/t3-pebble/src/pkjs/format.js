var NORMAL = "\x01",
  BOLD = "\x02",
  CODE = "\x03",
  KEYWORD = "\x04",
  STRING = "\x05",
  NUMBER = "\x06",
  COMMENT = "\x07";
var keywords =
  /^(?:if|then|else|fi|for|in|do|done|while|case|esac|function|return|export|const|let|var|function|class|import|from|return|async|await|true|false|null|undefined|def|import|print|sudo|cd|git|bun|npm|node|echo|cat|mkdir|grep|rg|ls|curl)$/;
function code(text) {
  return (
    CODE +
    text.replace(
      /(#[^\n]*|'[^'\n]*'|"(?:\\.|[^"\\])*"|\b\d+(?:\.\d+)?\b|\b[a-zA-Z_][\w-]*\b)/g,
      function (token) {
        var style =
          token[0] === "#"
            ? COMMENT
            : token[0] === "'" || token[0] === '"'
              ? STRING
              : /^\d/.test(token)
                ? NUMBER
                : keywords.test(token)
                  ? KEYWORD
                  : CODE;
        return style + token + CODE;
      }
    ) +
    NORMAL
  );
}
function inline(text) {
  return text.replace(
    /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\[([^\]]+)\]\([^)]+\)/g,
    function (_, codeText, bold, boldAlt, link) {
      return codeText ? code(codeText) : BOLD + (bold || boldAlt || link) + NORMAL;
    }
  );
}
module.exports = function format(text, type) {
  text = String(text || "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[^\n\r]*\r/g, "")
    .replace(/[\x01-\x07]/g, "");
  if (type === "command_execution") {
    text = text
      .split("\n")
      .filter(function (line) {
        return !/^\s*(?:N\/A|\d+(?:\.\d+)?)%\s*\[/.test(line);
      })
      .join("\n");
    return code(text.slice(0, 900));
  }
  text = text.slice(0, 900);
  var inCode = false;
  var lines = text.split("\n").map(function (line) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      return "";
    }
    if (inCode) return code(line);
    var heading = line.match(/^\s*#{1,6}\s+(.+)$/);
    if (heading) return BOLD + inline(heading[1]) + NORMAL;
    return inline(line.replace(/^\s*[-*]\s+/, "• "));
  });
  return lines.join("\n");
};
