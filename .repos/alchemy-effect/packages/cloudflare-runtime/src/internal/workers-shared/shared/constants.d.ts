// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/** Reserved header at the start of the whole manifest, NOT in each entry (currently unused)
 * manifest = [HEADER, [ entry = PATH_HASH, CONTENT_HASH, TAIL], [entry], ... , [entry] ]
 */
export declare const HEADER_SIZE = 20;
/** manifest = [HEADER, [ entry = PATH_HASH, CONTENT_HASH, TAIL], [entry], ... , [entry] ] */
export declare const PATH_HASH_SIZE = 16;
/** manifest = [HEADER, [ entry = PATH_HASH, CONTENT_HASH, TAIL], [entry], ... , [entry] ] */
export declare const CONTENT_HASH_SIZE = 16;
/** manifest = [HEADER, [ entry = PATH_HASH, CONTENT_HASH, TAIL], [entry], ... , [entry] ] */
export declare const TAIL_SIZE = 8;
/** offset of PATH_HASH from start of each entry
 *  manifest = [HEADER, [ entry = PATH_HASH, CONTENT_HASH, TAIL], [entry], ... , [entry] ] */
export declare const PATH_HASH_OFFSET = 0;
/** offset of CONTENT_HASH from start of each entry
 *  manifest = [HEADER, [ entry = PATH_HASH, CONTENT_HASH, TAIL], [entry], ... , [entry] ] */
export declare const CONTENT_HASH_OFFSET = 16;
/** manifest = [HEADER, [ entry = PATH_HASH, CONTENT_HASH, TAIL], [entry], ... , [entry] ] */
export declare const ENTRY_SIZE: number;
/**
 * Maximum number of assets that can be deployed with a Worker; this is a global
 * ceiling, and may vary by the user's subscription.
 */
export declare const MAX_ASSET_COUNT = 100000;
/** Maximum size per asset that can be deployed with a Worker */
export declare const MAX_ASSET_SIZE: number;
export declare const CF_ASSETS_IGNORE_FILENAME = ".assetsignore";
export declare const REDIRECTS_FILENAME = "_redirects";
export declare const HEADERS_FILENAME = "_headers";
//# sourceMappingURL=constants.d.ts.map
