// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
export const REDIRECTS_VERSION = 1;
export const HEADERS_VERSION = 2;

export const PERMITTED_STATUS_CODES = new Set([200, 301, 302, 303, 307, 308]);
export const HEADER_SEPARATOR = ":";
export const MAX_LINE_LENGTH = 2000;
export const MAX_HEADER_RULES = 100;
export const MAX_DYNAMIC_REDIRECT_RULES = 100;
export const MAX_STATIC_REDIRECT_RULES = 2000;
export const UNSET_OPERATOR = "! ";

export const SPLAT_REGEX = /\*/g;
export const PLACEHOLDER_REGEX = /:[A-Za-z]\w*/g;

/** Max number of rules in `run_worker_first` */
export const MAX_ROUTES_RULES = 100;
/** Max char length of each rule in `run_worker_first` */
export const MAX_ROUTES_RULE_LENGTH = 100;
