// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
export type RedirectLine = [from: string, to: string, status?: number];
export type RedirectRule = {
  from: string;
  to: string;
  status: number;
  lineNumber: number;
};

export type Headers = Record<string, string>;
export type HeadersRule = {
  path: string;
  headers: Headers;
  unsetHeaders: Array<string>;
};

export type InvalidRedirectRule = {
  line?: string;
  lineNumber?: number;
  message: string;
};

export type InvalidHeadersRule = {
  line?: string;
  lineNumber?: number;
  message: string;
};

export type ParsedRedirects = {
  invalid: Array<InvalidRedirectRule>;
  rules: Array<RedirectRule>;
};

export type ParsedHeaders = {
  invalid: Array<InvalidHeadersRule>;
  rules: Array<HeadersRule>;
};

export interface Logger {
  debug: (message: string) => void;
  log: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (error: Error) => void;
}
