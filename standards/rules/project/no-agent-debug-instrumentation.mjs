/**
 * Blocks temporary Cursor/agent debug POST instrumentation:
 * - Local ingest URLs (127.0.0.1:7871)
 * - X-Debug-Session-Id fetch headers
 * - // #region agent log markers used to wrap such blocks
 */

const REGION_MARKER = "#region agent log";

const STRING_FORBIDDEN = [
  {
    test: (s) => s.includes("X-Debug-Session-Id"),
    message:
      'Do not commit agent debug fetch headers (e.g. "X-Debug-Session-Id"). Use structured logging or your observability stack instead.',
  },
  {
    test: (s) => s.includes("127.0.0.1:7871"),
    message:
      "Do not commit local debug ingest calls (127.0.0.1:7871). Remove before merging or replace with proper logging.",
  },
];

const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Cursor/agent debug instrumentation patterns in application source.",
    },
    schema: [],
    messages: {
      forbiddenSubstring: "{{message}}",
      regionMarker:
        'Remove "// #region agent log" debug regions and their fetch instrumentation; use structured logging instead.',
    },
  },
  create(context) {
    function reportString(node, text) {
      for (const { test, message } of STRING_FORBIDDEN) {
        if (test(text)) {
          context.report({
            node,
            messageId: "forbiddenSubstring",
            data: { message },
          });
          return;
        }
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === "string") {
          reportString(node, node.value);
        }
      },
      TemplateElement(node) {
        if (node.value?.cooked != null) {
          reportString(node, node.value.cooked);
        }
      },
      "Program:exit"() {
        const sourceCode = context.sourceCode ?? context.getSourceCode?.();
        if (!sourceCode?.getAllComments) {
          return;
        }
        for (const comment of sourceCode.getAllComments()) {
          if (comment.value.includes(REGION_MARKER)) {
            context.report({
              loc: comment.loc,
              messageId: "regionMarker",
            });
          }
        }
      },
    };
  },
};

export default {
  rules: {
    "no-agent-debug-instrumentation": rule,
  },
};
