// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
//
// TypeScript port of `ignore` (https://github.com/kaelzhang/node-ignore) v7.0.5.
// Copyright (c) 2013 Kael Zhang <i@kael.me>, contributors. MIT License.

function makeArray<T>(subject: T | readonly T[]): T[] {
  return Array.isArray(subject) ? [...subject] : [subject as T];
}

const UNDEFINED = undefined;
const EMPTY = "";
const SPACE = " ";
const ESCAPE = "\\";
const REGEX_TEST_BLANK_LINE = /^\s+$/;
const REGEX_INVALID_TRAILING_BACKSLASH = /(?:[^\\]|^)\\$/;
const REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION = /^\\!/;
const REGEX_REPLACE_LEADING_EXCAPED_HASH = /^\\#/;
const REGEX_SPLITALL_CRLF = /\r?\n/g;

// Invalid:
// - /foo,
// - ./foo,
// - ../foo,
// - .
// - ..
// Valid:
// - .foo
const REGEX_TEST_INVALID_PATH = /^\.{0,2}\/|^\.{1,2}$/;

const REGEX_TEST_TRAILING_SLASH = /\/$/;

const SLASH = "/";

// Do not use ternary expression here, since "istanbul ignore next" is buggy
let TMP_KEY_IGNORE: string | symbol = "node-ignore";
/* istanbul ignore else */
if (typeof Symbol !== "undefined") {
  TMP_KEY_IGNORE = Symbol.for("node-ignore");
}
const KEY_IGNORE = TMP_KEY_IGNORE;

const define = <T>(object: object, key: PropertyKey, value: T): T => {
  Object.defineProperty(object, key, { value });
  return value;
};

const REGEX_REGEXP_RANGE = /([0-z])-([0-z])/g;

const RETURN_FALSE = () => false;

// Sanitize the range of a regular expression
// The cases are complicated, see test cases for details
const sanitizeRange = (range: string): string =>
  range.replace(REGEX_REGEXP_RANGE, (match, from, to) =>
    from.charCodeAt(0) <= to.charCodeAt(0)
      ? match
      : // Invalid range (out of order) which is ok for gitignore rules but
        //   fatal for JavaScript regular expression, so eliminate it.
        EMPTY,
  );

// > An optional `!` or `^` at the start of a class negates it, so that it
// >   matches any character not in the set. (gitignore(5), fnmatch(3))
// The leading `^` has already been escaped to `\^` by the metacharacter
//   escaper, so we strip the literal `!` or escaped `^` and emit a single
//   regex `^` which is the JavaScript negation token.
const negateRange = (range: string): string =>
  range.startsWith("!") || range.startsWith("\\^")
    ? `^${range.slice(range[0] === "!" ? 1 : 2)}`
    : range;

// See fixtures #59
const cleanRangeBackSlash = (slashes: string): string => {
  const { length } = slashes;
  return slashes.slice(0, length - (length % 2));
};

// > If the pattern ends with a slash,
// > it is removed for the purpose of the following description,
// > but it would only find a match with a directory.
// > In other words, foo/ will match a directory foo and paths underneath it,
// > but will not match a regular file or a symbolic link foo
// >  (this is consistent with the way how pathspec works in general in Git).
// '`foo/`' will not match regular file '`foo`' or symbolic link '`foo`'
// -> ignore-rules will not deal with it, because it costs extra `fs.stat` call
//      you could use option `mark: true` with `glob`

// '`foo/`' should not continue with the '`..`'
type Replacer = (this: string, ...args: any[]) => string;

const REPLACERS: Array<readonly [RegExp, Replacer]> = [
  [
    // Remove BOM
    // TODO:
    // Other similar zero-width characters?
    /^\uFEFF/,
    () => EMPTY,
  ],

  // > Trailing spaces are ignored unless they are quoted with backslash ("\")
  [
    // (a\ ) -> (a )
    // (a  ) -> (a)
    // (a ) -> (a)
    // (a \ ) -> (a  )
    /((?:\\\\)*?)(\\?\s+)$/,
    (_, m1, m2) => m1 + (m2.indexOf("\\") === 0 ? SPACE : EMPTY),
  ],

  // Replace (\ ) with ' '
  // (\ ) -> ' '
  // (\\ ) -> '\\ '
  // (\\\ ) -> '\\ '
  [
    /(\\+?)\s/g,
    (_, m1) => {
      const { length } = m1;
      return m1.slice(0, length - (length % 2)) + SPACE;
    },
  ],

  // Escape metacharacters
  // which is written down by users but means special for regular expressions.

  // > There are 12 characters with special meanings:
  // > - the backslash \,
  // > - the caret ^,
  // > - the dollar sign $,
  // > - the period or dot .,
  // > - the vertical bar or pipe symbol |,
  // > - the question mark ?,
  // > - the asterisk or star *,
  // > - the plus sign +,
  // > - the opening parenthesis (,
  // > - the closing parenthesis ),
  // > - and the opening square bracket [,
  // > - the opening curly brace {,
  // > These special characters are often called "metacharacters".
  [/[\\$.|*+(){^]/g, (match) => `\\${match}`],

  [
    // > a question mark (?) matches a single character
    /(?!\\)\?/g,
    () => "[^/]",
  ],

  // leading slash
  [
    // > A leading slash matches the beginning of the pathname.
    // > For example, "/*.c" matches "cat-file.c" but not "mozilla-sha1/sha1.c".
    // A leading slash matches the beginning of the pathname
    /^\//,
    () => "^",
  ],

  // replace special metacharacter slash after the leading slash
  [/\//g, () => "\\/"],

  [
    // > A leading "**" followed by a slash means match in all directories.
    // > For example, "**/foo" matches file or directory "foo" anywhere,
    // > the same as pattern "foo".
    // > "**/foo/bar" matches file or directory "bar" anywhere that is directly
    // >   under directory "foo".
    // Notice that the '*'s have been replaced as '\\*'
    /^\^*(?:\\\*\\\*\\\/)+/,

    // '**/foo' <-> 'foo'
    () => "^(?:.*\\/)?",
  ],

  // starting
  [
    // there will be no leading '/'
    //   (which has been replaced by section "leading slash")
    // If starts with '**', adding a '^' to the regular expression also works
    /^(?=[^^])/,
    function startingReplacer(this: string) {
      // If has a slash `/` at the beginning or middle
      return !/\/(?!$)/.test(this)
        ? // > Prior to 2.22.1
          // > If the pattern does not contain a slash /,
          // >   Git treats it as a shell glob pattern
          // Actually, if there is only a trailing slash,
          //   git also treats it as a shell glob pattern

          // After 2.22.1 (compatible but clearer)
          // > If there is a separator at the beginning or middle (or both)
          // > of the pattern, then the pattern is relative to the directory
          // > level of the particular .gitignore file itself.
          // > Otherwise the pattern may also match at any level below
          // > the .gitignore level.
          "(?:^|\\/)"
        : // > Otherwise, Git treats the pattern as a shell glob suitable for
          // >   consumption by fnmatch(3)
          "^";
    },
  ],

  // two globstars
  [
    // Use lookahead assertions so that we could match more than one `'/**'`
    /\\\/\\\*\\\*(?=\\\/|$)/g,

    // Zero, one or several directories
    // should not use '*', or it will be replaced by the next replacer

    // Check if it is not the last `'/**'`
    (_, index, str) =>
      index + 6 < str.length
        ? // case: /**/
          // > A slash followed by two consecutive asterisks then a slash matches
          // >   zero or more directories.
          // > For example, "a/**/b" matches "a/b", "a/x/b", "a/x/y/b" and so on.
          // '/**/'
          "(?:\\/[^\\/]+)*"
        : // case: /**
          // > A trailing `"/**"` matches everything inside.

          // #21: everything inside but it should not include the current folder
          "\\/.+",
  ],

  // normal intermediate wildcards
  [
    // Never replace escaped '*'
    // ignore rule '\*' will match the path '*'

    // 'abc.*/' -> go
    // 'abc.*'  -> skip this rule,
    //    coz trailing single wildcard will be handed by [trailing wildcard]
    /(^|[^\\]+)(\\\*)+(?=.+)/g,

    // '*.js' matches '.js'
    // '*.js' doesn't match 'abc'
    (_, p1, p2) => {
      // 1.
      // > An asterisk "*" matches anything except a slash.
      // 2.
      // > Other consecutive asterisks are considered regular asterisks
      // > and will match according to the previous rules.
      const unescaped = p2.replace(/\\\*/g, "[^\\/]*");
      return p1 + unescaped;
    },
  ],

  [
    // unescape, revert step 3 except for back slash
    // For example, if a user escape a '\\*',
    // after step 3, the result will be '\\\\\\*'
    /\\\\\\(?=[$.|*+(){^])/g,
    () => ESCAPE,
  ],

  [
    // '\\\\' -> '\\'
    /\\\\/g,
    () => ESCAPE,
  ],

  [
    // > The range notation, e.g. [a-zA-Z],
    // > can be used to match one of the characters in a range.

    // `\` is escaped by step 3
    /(\\)?\[([^\]/]*?)(\\*)($|\])/g,
    (match, leadEscape, range, endEscape, close) =>
      leadEscape === ESCAPE
        ? // '\\[bar]' -> '\\\\[bar\\]'
          `\\[${range}${cleanRangeBackSlash(endEscape)}${close}`
        : close === "]"
          ? endEscape.length % 2 === 0
            ? // A normal case, and it is a range notation
              // '[bar]'
              // '[bar\\\\]'
              `[${negateRange(sanitizeRange(range))}${endEscape}]`
            : // Invalid range notaton
              // '[bar\\]' -> '[bar\\\\]'
              "[]"
          : "[]",
  ],

  // ending
  [
    // 'js' will not match 'js.'
    // 'ab' will not match 'abc'
    /(?:[^*])$/,

    // WTF!
    // https://git-scm.com/docs/gitignore
    // changes in [2.22.1](https://git-scm.com/docs/gitignore/2.22.1)
    // which re-fixes #24, #38

    // > If there is a separator at the end of the pattern then the pattern
    // > will only match directories, otherwise the pattern can match both
    // > files and directories.

    // 'js*' will not match 'a.js'
    // 'js/' will not match 'a.js'
    // 'js' will match 'a.js' and 'a.js/'
    (match) =>
      /\/$/.test(match)
        ? // foo/ will not match 'foo'
          `${match}$`
        : // foo matches 'foo' and 'foo/'
          `${match}(?=$|\\/$)`,
  ],
];

const REGEX_REPLACE_TRAILING_WILDCARD = /(^|\\\/)?\\\*$/;
const MODE_IGNORE = "regex";
const MODE_CHECK_IGNORE = "checkRegex";

type MatcherMode = typeof MODE_IGNORE | typeof MODE_CHECK_IGNORE;

const TRAILING_WILD_CARD_REPLACERS: Record<MatcherMode, Replacer> = {
  [MODE_IGNORE](_, p1: string | undefined) {
    const prefix = p1
      ? // '\^':
        // '/*' does not match EMPTY
        // '/*' does not match everything

        // '\\\/':
        // 'abc/*' does not match 'abc/'
        `${p1}[^/]+`
      : // 'a*' matches 'a'
        // 'a*' matches 'aa'
        "[^/]*";

    return `${prefix}(?=$|\\/$)`;
  },

  [MODE_CHECK_IGNORE](_, p1: string | undefined) {
    // When doing `git check-ignore`
    const prefix = p1
      ? // '\\\/':
        // 'abc/*' DOES match 'abc/' !
        `${p1}[^/]*`
      : // 'a*' matches 'a'
        // 'a*' matches 'aa'
        "[^/]*";

    return `${prefix}(?=$|\\/$)`;
  },
};

// @param {pattern}
const makeRegexPrefix = (pattern: string): string =>
  REPLACERS.reduce(
    (prev, [matcher, replacer]) =>
      prev.replace(matcher, replacer.bind(pattern)),
    pattern,
  );

const isString = (subject: unknown): subject is string =>
  typeof subject === "string";

// > A blank line matches no files, so it can serve as a separator for readability.
const checkPattern = (pattern: string): boolean =>
  Boolean(
    pattern &&
    !REGEX_TEST_BLANK_LINE.test(pattern) &&
    !REGEX_INVALID_TRAILING_BACKSLASH.test(pattern) &&
    // > A line starting with # serves as a comment.
    pattern.indexOf("#") !== 0,
  );

const splitPattern = (pattern: string): string[] =>
  pattern.split(REGEX_SPLITALL_CRLF).filter(Boolean);

class IgnoreRule {
  readonly pattern: string;
  readonly mark: string | undefined;
  readonly negative: boolean;
  readonly body!: string;
  readonly ignoreCase!: boolean;
  readonly regexPrefix!: string;
  private _regex?: RegExp;
  private _checkRegex?: RegExp;

  constructor(
    pattern: string,
    mark: string | undefined,
    body: string,
    ignoreCase: boolean,
    negative: boolean,
    prefix: string,
  ) {
    this.pattern = pattern;
    this.mark = mark;
    this.negative = negative;

    define(this, "body", body);
    define(this, "ignoreCase", ignoreCase);
    define(this, "regexPrefix", prefix);
  }

  get regex() {
    const key = `_${MODE_IGNORE}` as const;

    if (this[key]) {
      return this[key];
    }

    return this._make(MODE_IGNORE, key);
  }

  get checkRegex() {
    const key = `_${MODE_CHECK_IGNORE}` as const;

    if (this[key]) {
      return this[key];
    }

    return this._make(MODE_CHECK_IGNORE, key);
  }

  _make(mode: MatcherMode, key: "_regex" | "_checkRegex"): RegExp {
    const str = this.regexPrefix.replace(
      REGEX_REPLACE_TRAILING_WILDCARD,

      // It does not need to bind pattern
      TRAILING_WILD_CARD_REPLACERS[mode],
    );

    const regex = this.ignoreCase ? new RegExp(str, "i") : new RegExp(str);

    return define(this, key, regex);
  }
}

const createRule = (
  { pattern, mark }: PatternParams,
  ignoreCase: boolean,
): IgnoreRule => {
  let negative = false;
  let body = pattern;

  // > An optional prefix "!" which negates the pattern;
  if (body.indexOf("!") === 0) {
    negative = true;
    body = body.substr(1);
  }

  body = body
    // > Put a backslash ("\") in front of the first "!" for patterns that
    // >   begin with a literal "!", for example, `"\!important!.txt"`.
    .replace(REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION, "!")
    // > Put a backslash ("\") in front of the first hash for patterns that
    // >   begin with a hash.
    .replace(REGEX_REPLACE_LEADING_EXCAPED_HASH, "#");

  const regexPrefix = makeRegexPrefix(body);

  return new IgnoreRule(pattern, mark, body, ignoreCase, negative, regexPrefix);
};

class RuleManager {
  private readonly _ignoreCase: boolean;
  _rules: IgnoreRule[] = [];
  private _added = false;

  constructor(ignoreCase: boolean) {
    this._ignoreCase = ignoreCase;
  }

  _add(pattern: string | Ignore | PatternParams): void {
    // #32
    const ignorePattern = pattern as Ignore & Record<PropertyKey, unknown>;
    if (pattern && ignorePattern[KEY_IGNORE]) {
      this._rules = this._rules.concat(ignorePattern._rules._rules);
      this._added = true;
      return;
    }

    if (isString(pattern)) {
      pattern = {
        pattern,
      };
    }

    const patternParams = pattern as PatternParams;
    if (checkPattern(patternParams.pattern)) {
      const rule = createRule(patternParams, this._ignoreCase);
      this._added = true;
      this._rules.push(rule);
    }
  }

  // @param {Array<string> | string | Ignore} pattern
  add(
    pattern: string | Ignore | PatternParams | readonly (string | Ignore)[],
  ): boolean {
    this._added = false;

    const patterns: readonly (string | Ignore | PatternParams)[] = isString(
      pattern,
    )
      ? splitPattern(pattern)
      : Array.isArray(pattern)
        ? pattern
        : [pattern as Ignore | PatternParams];
    patterns.forEach(this._add, this);

    return this._added;
  }

  // Test one single path without recursively checking parent directories
  //
  // - checkUnignored `boolean` whether should check if the path is unignored,
  //   setting `checkUnignored` to `false` could reduce additional
  //   path matching.
  // - check `string` either `MODE_IGNORE` or `MODE_CHECK_IGNORE`

  // @returns {TestResult} true if a file is ignored
  test(
    path: string,
    checkUnignored: boolean,
    mode: MatcherMode,
  ): IgnoreTestResult {
    let ignored = false;
    let unignored = false;
    let matchedRule: IgnoreRule | undefined;

    this._rules.forEach((rule) => {
      const { negative } = rule;

      //          |           ignored : unignored
      // -------- | ---------------------------------------
      // negative |   0:0   |   0:1   |   1:0   |   1:1
      // -------- | ------- | ------- | ------- | --------
      //     0    |  TEST   |  TEST   |  SKIP   |    X
      //     1    |  TESTIF |  SKIP   |  TEST   |    X

      // - SKIP: always skip
      // - TEST: always test
      // - TESTIF: only test if checkUnignored
      // - X: that never happen
      if (
        (unignored === negative && ignored !== unignored) ||
        (negative && !ignored && !unignored && !checkUnignored)
      ) {
        return;
      }

      const matched = rule[mode].test(path);

      if (!matched) {
        return;
      }

      ignored = !negative;
      unignored = negative;

      matchedRule = negative ? UNDEFINED : rule;
    });

    const ret: IgnoreTestResult = {
      ignored,
      unignored,
    };

    if (matchedRule) {
      ret.rule = matchedRule;
    }

    return ret;
  }
}

type ErrorConstructor = new (message: string) => Error;
type InvalidPathHandler = (
  message: string,
  constructor: ErrorConstructor,
) => boolean;

const throwError: InvalidPathHandler = (message, Ctor) => {
  throw new Ctor(message);
};

interface CheckPath {
  (path: unknown, originalPath: unknown, doThrow: InvalidPathHandler): boolean;
  isNotRelative: (path: string) => boolean;
  convert: (path: string) => string;
}

const checkPath: CheckPath = (path, originalPath, doThrow) => {
  if (!isString(path)) {
    return doThrow(
      `path must be a string, but got \`${originalPath}\``,
      TypeError,
    );
  }

  // We don't know if we should ignore EMPTY, so throw
  if (!path) {
    return doThrow(`path must not be empty`, TypeError);
  }

  // Check if it is a relative path
  if (checkPath.isNotRelative(path)) {
    const r = "`path.relative()`d";
    return doThrow(
      `path should be a ${r} string, but got "${originalPath}"`,
      RangeError,
    );
  }

  return true;
};

const isNotRelative = (path: string): boolean =>
  REGEX_TEST_INVALID_PATH.test(path);

checkPath.isNotRelative = isNotRelative;

// On windows, the following function will be replaced
/* istanbul ignore next */
checkPath.convert = (path) => path;

class Ignore {
  readonly [KEY_IGNORE]?: true;
  readonly _rules: RuleManager;
  private readonly _strictPathCheck: boolean;
  private _ignoreCache!: Record<string, IgnoreTestResult>;
  private _testCache!: Record<string, IgnoreTestResult>;

  constructor({
    ignorecase = true,
    ignoreCase = ignorecase,
    allowRelativePaths = false,
  }: IgnoreOptions = {}) {
    define(this, KEY_IGNORE, true);

    this._rules = new RuleManager(ignoreCase);
    this._strictPathCheck = !allowRelativePaths;
    this._initCache();
  }

  _initCache(): void {
    // A cache for the result of `.ignores()`
    this._ignoreCache = Object.create(null);

    // A cache for the result of `.test()`
    this._testCache = Object.create(null);
  }

  add(
    pattern: string | Ignore | readonly (string | Ignore)[] | PatternParams,
  ): this {
    if (this._rules.add(pattern)) {
      // Some rules have just added to the ignore,
      //   making the behavior changed,
      //   so we need to re-initialize the result cache
      this._initCache();
    }

    return this;
  }

  // legacy
  addPattern(pattern: string | readonly string[]): this {
    return this.add(pattern);
  }

  // @returns {TestResult}
  _test(
    originalPath: string,
    cache: Record<string, IgnoreTestResult>,
    checkUnignored: boolean,
    slices?: string[],
  ): IgnoreTestResult {
    const path =
      originalPath &&
      // Supports nullable path
      checkPath.convert(originalPath);

    checkPath(
      path,
      originalPath,
      this._strictPathCheck ? throwError : RETURN_FALSE,
    );

    return this._t(path, cache, checkUnignored, slices);
  }

  checkIgnore(path: string): IgnoreTestResult {
    // If the path doest not end with a slash, `.ignores()` is much equivalent
    //   to `git check-ignore`
    if (!REGEX_TEST_TRAILING_SLASH.test(path)) {
      return this.test(path);
    }

    const slices = path.split(SLASH).filter(Boolean);
    slices.pop();

    if (slices.length) {
      const parent = this._t(
        slices.join(SLASH) + SLASH,
        this._testCache,
        true,
        slices,
      );

      if (parent.ignored) {
        return parent;
      }
    }

    return this._rules.test(path, false, MODE_CHECK_IGNORE);
  }

  _t(
    // The path to be tested
    path: string,

    // The cache for the result of a certain checking
    cache: Record<string, IgnoreTestResult>,

    // Whether should check if the path is unignored
    checkUnignored: boolean,

    // The path slices
    slices?: string[],
  ): IgnoreTestResult {
    if (path in cache) {
      return cache[path];
    }

    if (!slices) {
      // path/to/a.js
      // ['path', 'to', 'a.js']
      slices = path.split(SLASH).filter(Boolean);
    }

    slices.pop();

    // If the path has no parent directory, just test it
    if (!slices.length) {
      return (cache[path] = this._rules.test(
        path,
        checkUnignored,
        MODE_IGNORE,
      ));
    }

    const parent = this._t(
      slices.join(SLASH) + SLASH,
      cache,
      checkUnignored,
      slices,
    );

    // If the path contains a parent directory, check the parent first
    return (cache[path] = parent.ignored
      ? // > It is not possible to re-include a file if a parent directory of
        // >   that file is excluded.
        parent
      : this._rules.test(path, checkUnignored, MODE_IGNORE));
  }

  ignores(path: string): boolean {
    return this._test(path, this._ignoreCache, false).ignored;
  }

  createFilter(): (path: string) => boolean {
    return (path: string) => !this.ignores(path);
  }

  filter(paths: readonly string[]): string[] {
    return makeArray(paths).filter(this.createFilter());
  }

  // @returns {TestResult}
  test(path: string): IgnoreTestResult {
    return this._test(path, this._testCache, true);
  }
}

const factory = (options?: IgnoreOptions): Ignore => new Ignore(options);

const isPathValid = (path: string): boolean =>
  checkPath(path && checkPath.convert(path), path, RETURN_FALSE);

/* istanbul ignore next */
const setupWindows = () => {
  /* eslint no-control-regex: "off" */
  const makePosix = (str: string): string =>
    /^\\\\\?\\/.test(str) || /["<>|\u0000-\u001F]+/u.test(str)
      ? str
      : str.replace(/\\/g, "/");

  checkPath.convert = makePosix;

  // 'C:\\foo'     <- 'C:\\foo' has been converted to 'C:/'
  // 'd:\\foo'
  const REGEX_TEST_WINDOWS_PATH_ABSOLUTE = /^[a-z]:\//i;
  checkPath.isNotRelative = (path: string) =>
    REGEX_TEST_WINDOWS_PATH_ABSOLUTE.test(path) || isNotRelative(path);
};

// Windows
// --------------------------------------------------------------
/* istanbul ignore next */
if (
  // Detect `process` so that it can run in browsers.
  typeof process !== "undefined" &&
  process.platform === "win32"
) {
  setupWindows();
}

// ES module exports (upstream uses `module.exports`). Upstream also exposes
// `setupWindows` via `Symbol.for("setupWindows")` for its own test suite; we
// drop that hook since it's unused.

export default factory as unknown as (
  options?: IgnoreOptions,
) => IgnoreInstance;
export { Ignore, isPathValid };

// --- Type declarations -----------------------------------------------------
// (not part of the verbatim upstream source; mirrors upstream `index.d.ts`)

type Pathname = string;

interface PatternParams {
  pattern: string;
  mark?: string;
}

interface IgnoreTestResult {
  ignored: boolean;
  unignored: boolean;
  rule?: IgnoreRule;
}

export interface IgnoreOptions {
  ignorecase?: boolean;
  /** For compatibility. */
  ignoreCase?: boolean;
  allowRelativePaths?: boolean;
}

export interface IgnoreInstance {
  add(
    patterns:
      | string
      | IgnoreInstance
      | readonly (string | IgnoreInstance)[]
      | PatternParams,
  ): this;
  filter(pathnames: readonly Pathname[]): Pathname[];
  createFilter(): (pathname: Pathname) => boolean;
  ignores(pathname: Pathname): boolean;
  test(pathname: Pathname): {
    ignored: boolean;
    unignored: boolean;
    rule?: { pattern: string; mark?: string; negative: boolean };
  };
  checkIgnore(pathname: Pathname): {
    ignored: boolean;
    unignored: boolean;
    rule?: { pattern: string; mark?: string; negative: boolean };
  };
}
