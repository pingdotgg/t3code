import { defineRule, type ESTree } from "@oxlint/plugins";

// Comments that switch a diagnostic off or on. None of them explains another.
const DIRECTIVE_PATTERN =
  /^\s*\*?\s*(?:(?:oxlint|eslint)-(?:disable|enable)|@ts-(?:expect-error|ignore|nocheck)|@effect-diagnostics)/u;
// TypeScript's own directives; whatever follows one is its reason.
const TS_DIRECTIVE_PATTERN = /^\s*\*?\s*@ts-(?:expect-error|ignore|nocheck)(?![\w-])(.*)$/su;
const EMPTY_COMMENT_PATTERN = /^[\s*]*$/u;

/**
 * Reports a directive that disables a lint rule or the type checker without saying why. The reason
 * is a `-- reason` suffix (text after the directive, for `@ts-*`) or a comment on the line above.
 */
export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Require every lint or type-checker suppression to say why.",
    },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      Program() {
        const comments = sourceCode.getAllComments();
        const ownLineCommentsByEndLine = new Map<number, ESTree.Comment>();
        for (const comment of comments) {
          const { line, column } = comment.loc.start;
          if ((sourceCode.lines[line - 1] ?? "").slice(0, column).trim() === "") {
            ownLineCommentsByEndLine.set(comment.loc.end.line, comment);
          }
        }

        // A comment directly above explains a directive, even across stacked directives and empty
        // comment lines.
        const explainedAbove = (directive: ESTree.Comment) => {
          let above = ownLineCommentsByEndLine.get(directive.loc.start.line - 1);
          while (
            above &&
            (DIRECTIVE_PATTERN.test(above.value) || EMPTY_COMMENT_PATTERN.test(above.value))
          ) {
            above = ownLineCommentsByEndLine.get(above.loc.start.line - 1);
          }
          return above !== undefined;
        };

        for (const directive of sourceCode.getDisableDirectives().directives) {
          if (directive.type === "enable" || directive.justification?.trim()) continue;
          if (explainedAbove(directive.node)) continue;
          context.report({
            loc: directive.node.loc,
            message:
              "Say why: end the directive with `-- reason` or put a comment on the line above.",
          });
        }

        for (const comment of comments) {
          const after = TS_DIRECTIVE_PATTERN.exec(comment.value)?.[1];
          if (after === undefined || after.replace(/^[\s:-]+/u, "").trim()) continue;
          if (explainedAbove(comment)) continue;
          context.report({
            loc: comment.loc,
            message:
              "Say why: write the reason after the directive or in a comment on the line above.",
          });
        }
      },
    };
  },
});
