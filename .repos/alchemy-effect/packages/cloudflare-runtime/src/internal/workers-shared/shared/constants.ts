// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
// -- Constants for manifest encoding/decoding --
// (header and tails are not currently being used for anything afaik)
// NB these all refer to bytes

/** Reserved header at the start of the whole manifest, NOT in each entry (currently unused)
 * manifest = [HEADER, [ entry = PATH_HASH, CONTENT_HASH, TAIL], [entry], ... , [entry] ]
 */
export const HEADER_SIZE = 20;
/** manifest = [HEADER, [ entry = PATH_HASH, CONTENT_HASH, TAIL], [entry], ... , [entry] ] */
export const PATH_HASH_SIZE = 16;
/** manifest = [HEADER, [ entry = PATH_HASH, CONTENT_HASH, TAIL], [entry], ... , [entry] ] */
export const CONTENT_HASH_SIZE = 16;
/** manifest = [HEADER, [ entry = PATH_HASH, CONTENT_HASH, TAIL], [entry], ... , [entry] ] */
export const TAIL_SIZE = 8;
/** offset of PATH_HASH from start of each entry
 *  manifest = [HEADER, [ entry = PATH_HASH, CONTENT_HASH, TAIL], [entry], ... , [entry] ] */
export const PATH_HASH_OFFSET = 0;
/** offset of CONTENT_HASH from start of each entry
 *  manifest = [HEADER, [ entry = PATH_HASH, CONTENT_HASH, TAIL], [entry], ... , [entry] ] */
export const CONTENT_HASH_OFFSET = PATH_HASH_SIZE;
/** manifest = [HEADER, [ entry = PATH_HASH, CONTENT_HASH, TAIL], [entry], ... , [entry] ] */
export const ENTRY_SIZE = PATH_HASH_SIZE + CONTENT_HASH_SIZE + TAIL_SIZE;

// -- Manifest creation constants --
// used in wrangler dev and deploy
/**
 * Maximum number of assets that can be deployed with a Worker; this is a global
 * ceiling, and may vary by the user's subscription.
 */
export const MAX_ASSET_COUNT = 100_000;
/** Maximum size per asset that can be deployed with a Worker */
export const MAX_ASSET_SIZE = 25 * 1024 * 1024;

export const CF_ASSETS_IGNORE_FILENAME = ".assetsignore";
export const REDIRECTS_FILENAME = "_redirects";
export const HEADERS_FILENAME = "_headers";
