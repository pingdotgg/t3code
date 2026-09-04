/**
 * Appended to the system prompt by every adapter whose provider accepts one
 * (Codex, Claude, OpenCode). ACP agents expose no such input. Chat renders
 * markdown images from workspace-relative and absolute paths, so the final
 * response is the right place for a screenshot, not a tool row.
 */
export const T3_CODE_INLINE_IMAGE_INSTRUCTIONS =
  "When an image helps the user judge the result (a screenshot, a rendered diff, a generated asset), embed it in your final response as markdown with the file path, for example `![Settings page after the change](/absolute/path/to/screenshot.png)`. T3 Code renders it inline in the chat.";
