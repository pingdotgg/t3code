// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
export declare const extractPathname: (
  path: string | undefined,
  includeSearch: boolean,
  includeHash: boolean,
) => string;
export declare const validateUrl: (
  token: string,
  onlyRelative?: boolean,
  disallowPorts?: boolean,
  includeSearch?: boolean,
  includeHash?: boolean,
) => [undefined, string] | [string, undefined];
export declare function urlHasHost(token: string): boolean;
//# sourceMappingURL=validateURL.d.ts.map
