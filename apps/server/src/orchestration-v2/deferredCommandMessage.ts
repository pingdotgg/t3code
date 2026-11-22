// SQLite's trim needs the characters JavaScript's String.prototype.trim removes spelled out.
export const JAVASCRIPT_TRIM_WHITESPACE =
  " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

const text = `json_extract(payload_json, '$.text')`;
const whitespace = `'${JAVASCRIPT_TRIM_WHITESPACE}'`;

/**
 * A user message that is a `/compact` or `/goal` command, whose turns defer context to the next
 * one. The partial index on it is only used when the read spells this text the same way.
 */
export const DEFERRED_COMMAND_MESSAGE_CONDITION = `role = 'user' AND (
  lower(trim(${text}, ${whitespace})) = '/compact'
  OR trim(${text}, ${whitespace}) GLOB '/goal*'
)`;
