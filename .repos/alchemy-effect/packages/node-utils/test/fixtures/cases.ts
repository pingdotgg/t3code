/* eslint quote-props: ["off"] */
import fs from "node:fs";
import path from "node:path";
const debug = (..._args) => {};
import ignore from "../../src/ignore.ts";

function readPatterns(file) {
  file = path.join(import.meta.dir, file);
  return fs.readFileSync(file).toString();
}

const IS_WINDOWS = process.platform === "win32";
const SHOULD_TEST_WINDOWS = IS_WINDOWS || !!process.env.IGNORE_TEST_WIN32;

// Not Windows, but want to mimic tests on Windows
if (!IS_WINDOWS && !!process.env.IGNORE_TEST_WIN32) {
  ignore[Symbol.for("setupWindows")]();
}

const caseDefinitions = [
  /////////////////////////////////////////////////////////////////////
  // [
  //   'Example',
  //   [
  //     // ignore pattern
  //     'a'
  //   ],
  //   {
  //     // 1 indicates 'a' should be ignored
  //     'a': 1
  //   }
  // ],
  /////////////////////////////////////////////////////////////////////
  [
    "#148",
    ["/.a/"],
    {
      ".a": 0,
    },
  ],
  [
    "#77: more cases for coverage",
    ["/*"],
    {
      a: 1,
      "a/": 1,
      "a/b/": 1,
    },
  ],
  [
    "#77: directory ending with / not always correctly ignored",
    ["c/*", { pattern: "foo/bar/*" }],
    {
      "c/": 1,
      c: 0,
      "foo/bar/": 1,
      "foo/bar": 0,
    },
    false,
    false,
    // Only for checkIgnore
    ["checkIgnore"],
  ],
  [
    "#108: gitignore rules with BOM",
    [readPatterns(".gitignore-with-BOM")],
    {
      node_modules: 1,
    },
  ],
  [
    "charactor ?",
    ["foo?bar"],
    {
      "foo/bar": 0,
      fooxbar: 1,
      fooxxbar: 0,
    },
  ],
  [
    "#57, normal * and normal consecutive *",
    ["**foo", "*bar", "ba*z", "folder/other-folder/**/**js"],
    {
      foo: 1,
      "a/foo": 1,
      afoo: 1,
      abfoo: 1,
      abcfoo: 1,
      bar: 1,
      abar: 1,
      baz: 1,
      "ba/z": 0,
      baaaaaaz: 1,
      "folder/other-folder/dir/main.js": 1,
    },
  ],
  [
    "#76 (invalid), comments with no heading whitespace",
    ["node_modules# comments"],
    {
      "node_modules/a.js": 0,
    },
  ],
  [
    "#59 and more cases about range notation",
    [
      "src/\\[foo\\]", // 1 -> 0

      "src/\\[bar]",

      "src/[e\\\\]",
      "s/[f\\\\\\\\]",

      "s/[a-z0-9]",

      // The following special cases are not described in gitignore manual
      "src/[q",
      "src/\\[u",
      "src/[x\\]",
    ],
    {
      "src/[foo]": 1,

      "src/[bar]": 1,

      "src/e": 1,
      "s/f": 1,

      "s/a": 1,

      "s/0": 1,

      "src/[q": 0,
      "src/[u": 1,
      "src/[x": 0,
      "src/[x]": 0,
      "src/x": 0,
    },
  ],
  [
    "gitignore 2.22.1 example",
    ["doc/frotz/"],
    {
      "doc/frotz/": 1,
      "a/doc/frotz/": 0,
    },
  ],
  [
    "#56",
    ["/*/", "!/foo/"],
    {
      "foo/bar.js": 0,
    },
  ],
  [
    "object prototype",
    ["*", "!hasOwnProperty", "!a"],
    {
      hasOwnProperty: 0,
      "a/hasOwnProperty": 0,
      toString: 1,
      "a/toString": 1,
    },
  ],
  [
    "a and a/",
    ["a", "a2", "b/", "b2/"],
    {
      a: 1,
      "a2/": 1,
      b: 0,
      "b2/": 1,
    },
  ],
  [
    "ending question mark",
    ["*.web?"],
    {
      "a.webp": 1,
      "a.webm": 1,
      // only match one characters
      "a.webam": 0,
      "a.png": 0,
    },
  ],
  [
    "intermediate question mark",
    ["a?c"],
    {
      abc: 1,
      acc: 1,
      ac: 0,
      abbc: 0,
    },
  ],
  [
    "multiple question marks",
    ["a?b??"],
    {
      acbdd: 1,
      acbddd: 0,
    },
  ],
  [
    "normal *.[oa]",
    ["*.[oa]"],
    {
      "a.js": 0,
      "a.a": 1,
      // test ending
      "a.aa": 0,
      "a.o": 1,
      "a.0": 0,
    },
  ],
  [
    "multiple brackets",
    ["*.[ab][cd][ef]"],
    {
      "a.ace": 1,
      "a.bdf": 1,
      "a.bce": 1,
      "a.abc": 0,
      "a.aceg": 0,
    },
  ],
  [
    "special case: []",
    ["*.[]"],
    {
      "a.[]": 0,
      "a.[]a": 0,
    },
  ],
  [
    "mixed with numbers, characters and symbols: *.[0a_]",
    ["*.[0a_]"],
    {
      "a.0": 1,
      "a.1": 0,
      "a.a": 1,
      "a.b": 0,
      "a._": 1,
      "a.=": 0,
    },
  ],
  [
    "range: [a-z]",
    ["*.pn[a-z]"],
    {
      "a.pn1": 0,
      "a.pn2": 0,
      "a.png": 1,
      "a.pna": 1,
    },
  ],
  [
    "range: [0-9]",
    ["*.pn[0-9]"],
    {
      "a.pn1": 1,
      "a.pn2": 1,
      "a.png": 0,
      "a.pna": 0,
    },
  ],
  [
    "multiple ranges: [0-9a-z]",
    ["*.pn[0-9a-z]"],
    {
      "a.pn1": 1,
      "a.pn2": 1,
      "a.png": 1,
      "a.pna": 1,
      "a.pn-": 0,
    },
  ],
  [
    // [0-z] represents 0-0A-Za-z
    "special range: [0-z]",
    ["*.[0-z]"],
    {
      "a.0": 1,
      "a.9": 1,
      "a.00": 0,
      "a.a": 1,
      "a.z": 1,
      "a.zz": 0,
    },
  ],
  [
    // If range is out of order, then omitted
    "special case: range out of order: [a-9]",
    ["*.[a-9]"],
    {
      "a.0": 0,
      "a.-": 0,
      "a.9": 0,
    },
  ],
  [
    // Just treat it as normal character set
    "special case: range-like character set",
    ["*.[a-]"],
    {
      "a.a": 1,
      "a.-": 1,
      "a.b": 0,
    },
  ],
  [
    "special case: the combination of range and set",
    ["*.[a-z01]"],
    {
      "a.a": 1,
      "a.b": 1,
      "a.z": 1,
      "a.0": 1,
      "a.1": 1,
      "a.2": 0,
    },
  ],
  [
    "special case: 1 step range",
    ["*.[0-0]"],
    {
      "a.0": 1,
      "a.1": 0,
      "a.-": 0,
    },
  ],
  [
    "special case: similar, but not a character set",
    ["*.[a-"],
    {
      "a.": 0,
      "a.[": 0,
      "a.a": 0,
      "a.-": 0,
    },
  ],
  [
    "related to #38",
    ["*", "!abc*"],
    {
      a: 1,
      abc: 0,
      abcd: 0,
    },
  ],
  [
    "#38",
    ["*", "!*/", "!foo/bar"],
    {
      a: 1,
      "b/c": 1,
      "foo/bar": 0,
      "foo/e": 1,
    },
  ],
  [
    'intermediate "\\ " should be unescaped to " "',
    ["abc\\ d", "abc e", "a\\ b\\ c"],
    {
      "abc d": 1,
      "abc e": 1,
      "abc/abc d": 1,
      "abc/abc e": 1,
      "abc/a b c": 1,
    },
  ],
  [
    "#25",
    [".git/*", "!.git/config", ".ftpconfig"],
    {
      ".ftpconfig": 1,
      ".git/config": 0,
      ".git/description": 1,
    },
  ],
  [
    "#26: .gitignore man page sample",
    [
      "# exclude everything except directory foo/bar",
      "/*",
      "!/foo",
      "/foo/*",
      "!/foo/bar",
    ],
    {
      "no.js": 1,
      "foo/no.js": 1,
      "foo/bar/yes.js": 0,
      "foo/bar/baz/yes.js": 0,
      "boo/no.js": 1,
    },
  ],
  [
    "wildcard: special case, escaped wildcard",
    ["*.html", "!a/b/\\*/index.html"],
    {
      "a/b/*/index.html": 0,
      "a/b/index.html": 1,
    },
  ],
  [
    "wildcard: treated as a shell glob suitable for consumption by fnmatch(3)",
    ["*.html", "!b/\\*/index.html"],
    {
      "a/b/*/index.html": 1,
      "a/b/index.html": 1,
    },
  ],
  [
    "wildcard: with no escape",
    ["*.html", "!a/b/*/index.html"],
    {
      "a/b/*/index.html": 0,
      "a/b/index.html": 1,
    },
  ],
  [
    "#24: a negative pattern without a trailing wildcard",
    ["/node_modules/*", "!/node_modules", "!/node_modules/package"],
    {
      "node_modules/a/a.js": 1,
      "node_modules/package/a.js": 0,
    },
  ],
  [
    "#21: unignore with 1 globstar, reversed order",
    ["!foo/bar.js", "foo/*"],
    {
      "foo/bar.js": 1,
      "foo/bar2.js": 1,
      "foo/bar/bar.js": 1,
    },
  ],

  [
    "#21: unignore with 2 globstars, reversed order",
    ["!foo/bar.js", "foo/**"],
    {
      "foo/bar.js": 1,
      "foo/bar2.js": 1,
      "foo/bar/bar.js": 1,
    },
  ],

  [
    "#21: unignore with several groups of 2 globstars, reversed order",
    ["!foo/bar.js", "foo/**/**"],
    {
      "foo/bar.js": 1,
      "foo/bar2.js": 1,
      "foo/bar/bar.js": 1,
    },
  ],

  [
    "#21: unignore with 1 globstar",
    ["foo/*", "!foo/bar.js"],
    {
      "foo/bar.js": 0,
      "foo/bar2.js": 1,
      "foo/bar/bar.js": 1,
    },
  ],

  [
    "#21: unignore with 2 globstars",
    ["foo/**", "!foo/bar.js"],
    {
      "foo/bar.js": 0,
      "foo/bar2.js": 1,
      "foo/bar/bar.js": 1,
    },
  ],

  [
    "related to #21: several groups of 2 globstars",
    ["foo/**/**", "!foo/bar.js"],
    {
      "foo/bar.js": 0,
      "foo/bar2.js": 1,
      "foo/bar/bar.js": 1,
    },
  ],

  // description  patterns  paths/expect  only
  [
    "ignore dot files",
    [".*"],
    {
      ".a": 1,
      ".gitignore": 1,
    },
  ],

  [
    "#14, README example broken in `3.0.3`",
    [".abc/*", "!.abc/d/"],
    {
      ".abc/a.js": 1,
      ".abc/d/e.js": 0,
    },
  ],

  [
    "#14, README example broken in `3.0.3`, not negate parent folder",
    [
      ".abc/*",
      // .abc/d will be ignored
      "!.abc/d/*",
    ],
    {
      ".abc/a.js": 1,
      // so '.abc/d/e.js' will be ignored
      ".abc/d/e.js": 1,
    },
  ],

  [
    "A blank line matches no files",
    [""],
    {
      a: 0,
      "a/b/c": 0,
    },
  ],
  [
    "A line starting with # serves as a comment.",
    ["#abc"],
    {
      "#abc": 0,
    },
  ],
  [
    'Put a backslash ("\\") in front of the first hash for patterns that begin with a hash.',
    ["\\#abc"],
    {
      "#abc": 1,
    },
  ],
  [
    'Trailing spaces are ignored unless they are quoted with backslash ("\\")',
    [
      "abc\\  ", // only one space left -> (abc )
      "bcd  ", // no space left -> (bcd)
      "cde \\ ", // two spaces -> (cde  )
      "def ", // no space left -> (def)
    ],
    {
      // nothing to do with backslashes
      "abc\\  ": 0,
      "abc  ": 0,
      "abc ": 1,
      "abc   ": 0,
      bcd: 1,
      "bcd ": 0,
      "bcd  ": 0,
      "cde  ": 1,
      "cde ": 0,
      "cde   ": 0,
      def: 1,
      "def ": 0,
    },
    false,
    true,
  ],
  [
    'An optional prefix "!" which negates the pattern; any matching file excluded by a previous pattern will become included again',
    ["abc", "!abc"],
    {
      // the parent folder is included again
      "abc/a.js": 0,
      "abc/": 0,
    },
  ],
  [
    "issue #10: It is not possible to re-include a file if a parent directory of that file is excluded",
    ["/abc/", "!/abc/a.js"],
    {
      "abc/a.js": 1,
      "abc/d/e.js": 1,
    },
  ],
  [
    "we did not know whether the rule is a dir first",
    ["abc", "!bcd/abc/a.js"],
    {
      "abc/a.js": 1,
      "bcd/abc/a.js": 1,
    },
  ],
  [
    'Put a backslash ("\\") in front of the first "!" for patterns that begin with a literal "!"',
    ["\\!abc", "\\!important!.txt"],
    {
      "!abc": 1,
      abc: 0,
      "b/!important!.txt": 1,
      "!important!.txt": 1,
    },
  ],

  [
    "If the pattern ends with a slash, it is removed for the purpose of the following description, but it would only find a match with a directory",
    ["abc/"],
    {
      // actually, node-ignore have no idea about fs.Stat,
      // you should `glob({mark: true})`
      abc: 0,
      "abc/": 1,

      // Actually, if there is only a trailing slash, git also treats it as a shell glob pattern
      // 'abc/' should make 'bcd/abc/' ignored.
      "bcd/abc/": 1,
    },
  ],

  [
    "If the pattern does not contain a slash /, Git treats it as a shell glob pattern",
    ["a.js", "f/"],
    {
      "a.js": 1,
      "b/a/a.js": 1,
      "a/a.js": 1,
      "b/a.jsa": 0,
      "f/": 1,
      "g/f/": 1,
    },
  ],
  [
    "Otherwise, Git treats the pattern as a shell glob suitable for consumption by fnmatch(3) with the FNM_PATHNAME flag",
    ["a/a.js"],
    {
      "a/a.js": 1,
      "a/a.jsa": 0,
      "b/a/a.js": 0,
      "c/a/a.js": 0,
    },
  ],

  [
    "wildcards in the pattern will not match a / in the pathname.",
    ["Documentation/*.html"],
    {
      "Documentation/git.html": 1,
      "Documentation/ppc/ppc.html": 0,
      "tools/perf/Documentation/perf.html": 0,
    },
  ],

  [
    "A leading slash matches the beginning of the pathname",
    ["/*.c"],
    {
      "cat-file.c": 1,
      "mozilla-sha1/sha1.c": 0,
    },
  ],

  [
    'A leading "**" followed by a slash means match in all directories',
    ["**/foo"],
    {
      foo: 1,
      "a/foo": 1,
      "foo/a": 1,
      "a/foo/a": 1,
      "a/b/c/foo/a": 1,
    },
  ],

  [
    '"**/foo/bar" matches file or directory "bar" anywhere that is directly under directory "foo"',
    ["**/foo/bar"],
    {
      "foo/bar": 1,
      "abc/foo/bar": 1,
      "abc/foo/bar/": 1,
    },
  ],

  [
    'A trailing "/**" matches everything inside',
    ["abc/**"],
    {
      "abc/a/": 1,
      "abc/b": 1,
      "abc/d/e/f/g": 1,
      "bcd/abc/a": 0,
      abc: 0,
    },
  ],

  [
    "A slash followed by two consecutive asterisks then a slash matches zero or more directories",
    ["a/**/b"],
    {
      "a/b": 1,
      "a/x/b": 1,
      "a/x/y/b": 1,
      "b/a/b": 0,
    },
  ],

  [
    "add a file content",
    readPatterns(".aignore"),
    {
      "abc/a.js": 1,
      "abc/b/b.js": 1,
      "#e": 0,
      "#f": 1,
    },
  ],

  // old test cases
  [
    "should excape metacharacters of regular expressions",
    [
      "*.js",
      "!\\*.js",
      "!a#b.js",
      "!?.js",

      // comments
      "#abc",

      "\\#abc",
    ],
    {
      "*.js": 0,
      "abc.js": 1,
      "a#b.js": 0,
      abc: 0,
      "#abc": 1,
      "?.js": 0,
    },
  ],

  [
    "issue #2: question mark should not break all things",
    readPatterns(".ignore-issue-2"),
    {
      ".project": 1,
      // remain
      "abc/.project": 0,
      ".a.sw": 0,
      ".a.sw?": 1,
      "thumbs.db": 1,
    },
  ],
  [
    'dir ended with "*"',
    ["abc/*"],
    {
      abc: 0,
    },
  ],
  [
    'file ended with "*"',
    ["abc.js*"],
    {
      "abc.js/": 1,
      "abc.js/abc": 1,
      "abc.jsa/": 1,
      "abc.jsa/abc": 1,
    },
  ],
  [
    "wildcard as filename",
    ["*.b"],
    {
      "b/a.b": 1,
      "b/.b": 1,
      "b/.ba": 0,
      "b/c/a.b": 1,
    },
  ],
  [
    "slash at the beginning and come with a wildcard",
    ["/*.c"],
    {
      ".c": 1,
      "c.c": 1,
      "c/c.c": 0,
      "c/d": 0,
    },
  ],
  [
    "dot file",
    [".d"],
    {
      ".d": 1,
      ".dd": 0,
      "d.d": 0,
      "d/.d": 1,
      "d/d.d": 0,
      "d/e": 0,
    },
  ],
  [
    "dot dir",
    [".e"],
    {
      ".e/": 1,
      ".ee/": 0,
      "e.e/": 0,
      ".e/e": 1,
      "e/.e": 1,
      "e/e.e": 0,
      "e/f": 0,
    },
  ],
  [
    "node modules: once",
    ["node_modules/"],
    {
      "node_modules/gulp/node_modules/abc.md": 1,
      "node_modules/gulp/node_modules/abc.json": 1,
    },
  ],
  [
    "node modules: sub directories",
    ["node_modules"],
    {
      "a/b/node_modules/abc.md": 1,
    },
  ],
  [
    "node modules: twice",
    ["node_modules/", "node_modules/"],
    {
      "node_modules/gulp/node_modules/abc.md": 1,
      "node_modules/gulp/node_modules/abc.json": 1,
    },
  ],
  [
    "unicode characters in windows paths",
    ["test"],
    {
      "some/path/to/test/ignored.js": 1,
      "some/special/path/to/目录/test/ignored.js": 1,
    },
    false,
    true, // git-check-ignore fails as git converts special chars to escaped unicode before printing
  ],
];

if (!SHOULD_TEST_WINDOWS) {
  caseDefinitions.push(
    [
      "#68: ignore test for files named ...",
      ["/...", "/....."],
      {
        "...": 1,
        "....": 0,
        ".....": 1,
        "......": 0,
      },
    ],
    [
      "#68: file named ...",
      [],
      {
        "...": 0,
        "....": 0,
        ".....": 0,
      },
    ],
    [
      "#130: consequent escaped backslashes with whitespaces",
      ["a\\\\ ", "a\\\\ b", "a\\\\\\ b"],
      {
        "a\\": 1,
        "a\\ b": 1,
        "a\\\\ b": 0,
        "a\\\\\\ b": 0,
      },
    ],
    [
      "#81: invalid trailing backslash at the end should not throw, test non-windows env only",
      [
        "test\\",
        "testa\\\\",
        "\\",
        "foo/*",
        // test negative pattern
        "!foo/test\\",
      ],
      {
        test: 0,
        "test\\": 0,
        "testa\\": 1,
        "\\": 0,
        "foo/test\\": 1,
      },
    ],
    [
      "linux: back slashes on paths",
      ["a", "b\\\\c"],
      {
        "b\\c/a.md": 1,
        "a\\b/a.js": 0,
        "a\\b/a": 1,
        "a/a.js": 1,
      },
    ],
    [
      "#59: test cases for linux only",
      [
        "src/\\[foo\\]", // 1 -> 0
        "src/\\[foo2\\\\]", // 2 -> 1
        "src/\\[foo3\\\\\\]", // 3 -> 1
        "src/\\[foo4\\\\\\\\]", // 4 -> 2
        "src/\\[foo5\\\\\\\\\\]", // 5 -> 2
        "src/\\[foo6\\\\\\\\\\\\]", // 6 -> 3

        "src/\\[bar]",

        "src/[e\\\\]",
        "s/[f\\\\\\\\]",

        "s/[a-z0-9]",
      ],
      {
        "src/[foo]": 1,
        "src/[foo2\\]": 1,

        // Seems the followings are side-effects,
        // however, we will implement these
        "src/[foo3\\]": 1,
        "src/[foo4\\\\]": 1,
        "src/[foo5\\\\]": 1,
        "src/[foo6\\\\\\]": 1,

        "src/[bar]": 1,

        "src/e": 1,
        "src/\\": 1,
        "s/f": 1,
        "s/\\": 1,

        "s/a": 1,

        "s/0": 1,
      },
    ],
  );
}

const cases_to_test_only = caseDefinitions.filter((c) => c[3]);

const real_cases = cases_to_test_only.length
  ? cases_to_test_only
  : caseDefinitions;

export const cases = (iteratee) => {
  real_cases.forEach((single) => {
    const [
      description,
      patterns,
      paths_object,
      test_only,
      skip_test_fixture,
      scopes = false,
    ] = single;

    // All paths to test
    const paths = Object.keys(paths_object);

    // paths that NOT ignored
    let expected = paths.filter((p) => !paths_object[p]).sort();

    function expect_result(t, result, mapper) {
      if (mapper) {
        expected = expected.map(mapper);
      }

      t.same(result.sort(), expected.sort());
    }

    iteratee({
      description,
      patterns,
      paths_object,
      test_only,
      skip_test_fixture,
      paths,
      scopes,
      expected,
      expect_result,
    });
  });
};

// For local testing purpose
const ENV_KEYS = [
  "IGNORE_ONLY_FILTER",
  "IGNORE_ONLY_CREATE_FILTER",
  "IGNORE_ONLY_IGNORES",
  "IGNORE_ONLY_CHECK_IGNORE",
  "IGNORE_ONLY_WIN32",
  "IGNORE_ONLY_FIXTURES",
  "IGNORE_ONLY_OTHERS",
];

const envs = {};
let hasOnly = false;
ENV_KEYS.forEach((key) => {
  const value = !!process.env[key];
  envs[key] = value;

  if (value) {
    hasOnly = true;
  }
});

export const checkEnv = (key) => (hasOnly ? !!envs[key] : true);

export { IS_WINDOWS };
export { SHOULD_TEST_WINDOWS };

export { debug };
