function getPropertyName(node) {
  if (!node) {
    return null;
  }
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return null;
}

function isProcessEnvMemberExpression(node) {
  if (!node || node.type !== "MemberExpression") {
    return false;
  }
  if (node.object?.type !== "Identifier" || node.object.name !== "process") {
    return false;
  }
  return getPropertyName(node.property) === "env";
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow direct process.env access outside approved runtime-profile files.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowPatterns: {
            type: "array",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      noProcessEnv:
        "Use a config module or an allowed entry point instead of reading process.env directly.",
    },
  },
  create(context) {
    const filename = context.getFilename().replace(/\\/g, "/");
    const option = context.options[0] ?? {};
    const allowPatterns = Array.isArray(option.allowPatterns)
      ? option.allowPatterns.map((pattern) => new RegExp(pattern))
      : [];

    if (filename === "<input>" || filename === "<text>") {
      return {};
    }

    const isAllowedFile = allowPatterns.some((pattern) => pattern.test(filename));

    if (isAllowedFile) {
      return {};
    }

    return {
      MemberExpression(node) {
        if (!isProcessEnvMemberExpression(node)) {
          return;
        }

        context.report({
          node,
          messageId: "noProcessEnv",
        });
      },
    };
  },
};

export default {
  rules: {
    "no-process-env-outside-runtime-profile": rule,
  },
};
