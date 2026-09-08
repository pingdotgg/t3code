// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { describe, test } from "vitest";
import {
  generateRulesMatcher,
  generateStaticRoutingRuleMatcher,
  replacer,
} from "../src/utils/rules-engine.ts";

describe("rules engine", () => {
  test("it should match simple pathname hosts", ({ expect }) => {
    const matcher = generateRulesMatcher({ "/test": 1, "/some%20page": 2 });
    expect(
      matcher({ request: new Request("https://example.com/test") }),
    ).toEqual([1]);
    expect(
      matcher({ request: new Request("https://example.com/some page") }),
    ).toEqual([2]);
  });

  test("it should match cross-host requests", ({ expect }) => {
    const matcher = generateRulesMatcher({
      "/test": 1,
      "/anotherpage": 2,
      "https://custom.domain/test": 3,
      "https://another.domain/test": 4,
      "//fake.host/actually-a-path": 5,
    });
    expect(
      matcher({ request: new Request("https://custom.domain/test") }),
    ).toEqual([1, 3]);
    expect(
      matcher({
        request: new Request("https://example.com//fake.host/actually-a-path"),
      }),
    ).toEqual([5]);
    expect(
      matcher({
        request: new Request("other://custom.domain:123/test"),
      }),
    ).toEqual([1, 3]);
  });

  test("it should escape funky rules", ({ expect }) => {
    const matcher = generateRulesMatcher({
      "/$~.%20/!+-/[bo|%7Bo%7D]...()": 1,
    });
    expect(
      matcher({
        request: new Request("https://example.com/$~. \\!+-/[bo|{o}]...()"),
      }),
    ).toEqual([1]);
  });

  test("it should support splats and placeholders", ({ expect }) => {
    const matcher = generateRulesMatcher(
      {
        "/foo/test/*": "1/:splat",
        "/foo/*": "2/:splat",
        "/blog/:code/:name": "3/:name/:code",
        "/blog/*": "4/:splat",
        "https://:subdomain.pages.:tld/*": "5/:subdomain/:tld/:splat",
        "https://next.:subdomain.pages.:tld/*": "6/:subdomain/",
      },
      (match, replacements) => replacer(match, replacements),
    );
    expect(
      matcher({ request: new Request("https://example.com/foo/test/yes") }),
    ).toEqual(["1/yes", "2/test/yes"]);
    expect(
      matcher({ request: new Request("https://example.com/foo/test/") }),
    ).toEqual(["1/", "2/test/"]);
    expect(
      matcher({ request: new Request("https://example.com/foo/test") }),
    ).toEqual(["2/test"]);
    expect(
      matcher({ request: new Request("https://example.com/foo/") }),
    ).toEqual(["2/"]);
    expect(
      matcher({ request: new Request("https://example.com/foo") }),
    ).toEqual([]);
    expect(
      matcher({
        request: new Request("https://example.com/blog/123/tricycle"),
      }),
    ).toEqual(["3/tricycle/123", "4/123/tricycle"]);
    expect(
      matcher({ request: new Request("https://my.pages.dev/magic") }),
    ).toEqual(["5/my/dev/magic"]);
    expect(
      matcher({ request: new Request("https://next.my.pages.dev/magic") }),
    ).toEqual(["6/my/"]);
  });
});

describe("replacer", () => {
  test("should replace splats", ({ expect }) => {
    expect(replacer("/blog/:splat", { splat: "look/a/value" })).toEqual(
      "/blog/look/a/value",
    );
  });

  test("should replace placeholders", ({ expect }) => {
    expect(
      replacer("/:code/:name.jpg", { name: "tricycle", code: "123" }),
    ).toEqual("/123/tricycle.jpg");
  });

  test("should replace splats and placeholders", ({ expect }) => {
    expect(
      replacer("/:code/:splat", { splat: "tricycle/images", code: "123" }),
    ).toEqual("/123/tricycle/images");
  });

  test("should replace all instances of placeholders", ({ expect }) => {
    expect(
      replacer(
        "Link: </assets/:value/main.js>; rel=preload; as=script, </assets/:value/lang.js>; rel=preload; as=script",
        { value: "js" },
      ),
    ).toEqual(
      "Link: </assets/js/main.js>; rel=preload; as=script, </assets/js/lang.js>; rel=preload; as=script",
    );
  });
});

describe("static routing rules", () => {
  test("should return true for a request that matches", ({ expect }) => {
    expect(
      generateStaticRoutingRuleMatcher(["/some/path"])({
        request: new Request("https://site.com/some/path"),
      }),
    ).toEqual(true);

    expect(
      generateStaticRoutingRuleMatcher(["/some/*"])({
        request: new Request("https://site.com/some/path"),
      }),
    ).toEqual(true);

    expect(
      generateStaticRoutingRuleMatcher(["/no/match", "/some/*"])({
        request: new Request("https://site.com/some/path"),
      }),
    ).toEqual(true);
  });

  test("should return false for a request that does not match", ({
    expect,
  }) => {
    expect(
      generateStaticRoutingRuleMatcher(["/some/path"])({
        request: new Request("https://site.com"),
      }),
    ).toEqual(false);

    expect(
      generateStaticRoutingRuleMatcher(["/some/*"])({
        request: new Request("https://site.com/path"),
      }),
    ).toEqual(false);

    expect(
      generateStaticRoutingRuleMatcher(["/some/path", "/other/path"])({
        request: new Request("https://site.com/path"),
      }),
    ).toEqual(false);

    expect(
      generateStaticRoutingRuleMatcher([])({
        request: new Request("https://site.com/some/path"),
      }),
    ).toEqual(false);
  });

  test("should ignore regex characters other than a glob", ({ expect }) => {
    {
      const matcher = generateStaticRoutingRuleMatcher(["/"]);
      expect(matcher({ request: new Request("http://example.com/") })).toEqual(
        true,
      );
      expect(matcher({ request: new Request("http://example.com") })).toEqual(
        true,
      );
      expect(
        matcher({ request: new Request("http://example.com/?foo=bar") }),
      ).toEqual(true);
      expect(matcher({ request: new Request("https://example.com/") })).toEqual(
        true,
      );
      expect(
        matcher({ request: new Request("http://example.com/foo") }),
      ).toEqual(false);
    }

    {
      const matcher = generateStaticRoutingRuleMatcher(["/foo"]);
      expect(
        matcher({ request: new Request("http://example.com/foo") }),
      ).toEqual(true);
      expect(matcher({ request: new Request("https://example.com/") })).toEqual(
        false,
      );
      expect(
        matcher({ request: new Request("https://example.com/foo/") }),
      ).toEqual(false);
      expect(
        matcher({ request: new Request("https://example.com/foo/bar") }),
      ).toEqual(false);
      expect(
        matcher({ request: new Request("https://example.com/baz") }),
      ).toEqual(false);
      expect(
        matcher({ request: new Request("https://example.com/baz/foo") }),
      ).toEqual(false);
      expect(
        matcher({ request: new Request("https://example.com/foobar") }),
      ).toEqual(false);
    }

    {
      const matcher = generateStaticRoutingRuleMatcher(["/:placeholder"]);
      expect(
        matcher({ request: new Request("http://example.com/foo") }),
      ).toEqual(false);
      expect(
        matcher({ request: new Request("https://example.com/:placeholder") }),
      ).toEqual(true);
    }

    {
      const matcher = generateStaticRoutingRuleMatcher(["/foo*"]);
      expect(
        matcher({ request: new Request("http://example.com/foo") }),
      ).toEqual(true);
      expect(
        matcher({ request: new Request("https://example.com/foo/") }),
      ).toEqual(true);
      expect(
        matcher({ request: new Request("https://example.com/foo/bar") }),
      ).toEqual(true);
      expect(
        matcher({ request: new Request("https://example.com/foobar") }),
      ).toEqual(true);
      expect(matcher({ request: new Request("https://example.com/") })).toEqual(
        false,
      );
      expect(
        matcher({ request: new Request("https://example.com/baz") }),
      ).toEqual(false);
      expect(
        matcher({ request: new Request("https://example.com/baz/foo") }),
      ).toEqual(false);
    }

    {
      const matcher = generateStaticRoutingRuleMatcher(["/*.html"]);
      expect(
        matcher({ request: new Request("http://example.com/foo.html") }),
      ).toEqual(true);
      expect(
        matcher({ request: new Request("http://example.com/foo/bar.html") }),
      ).toEqual(true);
      expect(matcher({ request: new Request("http://example.com/") })).toEqual(
        false,
      );
      expect(
        matcher({ request: new Request("http://example.com/foo") }),
      ).toEqual(false);
      expect(
        matcher({ request: new Request("http://example.com/foo/bar") }),
      ).toEqual(false);
    }

    {
      const matcher = generateStaticRoutingRuleMatcher(["/login/*"]);
      expect(
        matcher({ request: new Request("http://example.com/login/foo") }),
      ).toEqual(true);
      expect(
        matcher({ request: new Request("http://example2.com/login/foo") }),
      ).toEqual(true);
      expect(
        matcher({ request: new Request("http://example.com/foo/login/foo") }),
      ).toEqual(false);
      expect(
        matcher({
          request: new Request("http://example.com/foo?bar=baz/login/foo"),
        }),
      ).toEqual(false);
    }

    {
      const matcher = generateStaticRoutingRuleMatcher(["/*"]);
      expect(
        matcher({ request: new Request("http://foo.example.com/bar") }),
      ).toEqual(true);
      expect(
        matcher({
          request: new Request("http://example2.com/foo.example.com/baz"),
        }),
      ).toEqual(true);
      expect(
        matcher({
          request: new Request("http://example2.com/?q=foo.example.com/baz"),
        }),
      ).toEqual(true);
      expect(
        matcher({ request: new Request("https://example.com/foo.html") }),
      ).toEqual(true);
      expect(
        matcher({ request: new Request("https://example.com/foo/bar.html") }),
      ).toEqual(true);
      expect(
        matcher({ request: new Request("http://example.com/foo") }),
      ).toEqual(true);
      expect(
        matcher({ request: new Request("https://example.com/foo/") }),
      ).toEqual(true);
      expect(
        matcher({ request: new Request("https://example.com/foo/bar") }),
      ).toEqual(true);
      expect(
        matcher({ request: new Request("https://example.com/foobar") }),
      ).toEqual(true);
      expect(matcher({ request: new Request("http://example.com/") })).toEqual(
        true,
      );
      expect(matcher({ request: new Request("https://example.com/") })).toEqual(
        true,
      );
      expect(matcher({ request: new Request("http://example.com") })).toEqual(
        true,
      );
      expect(matcher({ request: new Request("https://example.com") })).toEqual(
        true,
      );
    }

    {
      const matcher = generateStaticRoutingRuleMatcher(["*/*"]);
      expect(
        matcher({ request: new Request("http://foo.example.com/bar") }),
      ).toEqual(true);
      expect(
        matcher({
          request: new Request("http://example2.com/foo.example.com/baz"),
        }),
      ).toEqual(true);
      expect(
        matcher({
          request: new Request("http://example2.com/?q=foo.example.com/baz"),
        }),
      ).toEqual(true);
      expect(
        matcher({ request: new Request("https://example.com/foo.html") }),
      ).toEqual(true);
      expect(
        matcher({ request: new Request("https://example.com/foo/bar.html") }),
      ).toEqual(true);
      expect(
        matcher({ request: new Request("http://example.com/foo") }),
      ).toEqual(true);
      expect(
        matcher({ request: new Request("https://example.com/foo/") }),
      ).toEqual(true);
      expect(
        matcher({ request: new Request("https://example.com/foo/bar") }),
      ).toEqual(true);
      expect(
        matcher({ request: new Request("https://example.com/foobar") }),
      ).toEqual(true);
      expect(matcher({ request: new Request("http://example.com/") })).toEqual(
        true,
      );
      expect(matcher({ request: new Request("https://example.com/") })).toEqual(
        true,
      );
      expect(matcher({ request: new Request("http://example.com") })).toEqual(
        true,
      );
      expect(matcher({ request: new Request("https://example.com") })).toEqual(
        true,
      );
    }
  });
});
