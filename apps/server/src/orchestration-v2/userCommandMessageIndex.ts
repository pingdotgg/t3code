// SQLite trim defaults to ASCII spaces; command recognition uses JavaScript trim.
export const javascriptTrimWhitespace =
  " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

export const userCommandMessageIndex = "orchestration_v2_projection_messages_user_command_idx";

// A query uses the expression index only when it repeats this expression verbatim, literals included.
// '/comp' and '/goal' find every /compact and /goal candidate; callers still apply the exact checks.
export const userCommandPrefix = `lower(substr(ltrim(json_extract(payload_json, '$.text'), '${javascriptTrimWhitespace}'), 1, 5))`;
