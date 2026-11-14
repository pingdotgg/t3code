import { matchRoute, routePatternUrl } from "@alchemy.run/cloudflare/Workers/RoutePattern";
import { describe, expect, it } from "@alchemy.run/test";

const route = (pattern: string) => ({ pattern });

describe(
  "matchRoute",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  () => {
    it("matches Cloudflare route semantics", () => {
      const routes = [
        route("example.com/*"),
        route("example.com/users/*"),
        route("example.com/users/health"),
        route("*.example.com/*"),
        route("www.example.com/*"),
        route("https://secure.example.com/app*"),
      ];
      const match = (host: string, path: string) => matchRoute(routes, host, path)?.pattern;

      expect(match("example.com", "/")).toBe("example.com/*");
      // The longer path wins.
      expect(match("example.com", "/users/1")).toBe("example.com/users/*");
      // `/users/*` does not match `/users`.
      expect(match("example.com", "/users")).toBe("example.com/*");
      // An exact path beats a prefix.
      expect(match("example.com", "/users/health")).toBe("example.com/users/health");
      // An exact host beats a wildcard host.
      expect(match("www.example.com", "/")).toBe("www.example.com/*");
      expect(match("api.example.com", "/")).toBe("*.example.com/*");
      // Hosts are case-insensitive, paths case-sensitive.
      expect(match("EXAMPLE.com", "/Users/1")).toBe("example.com/*");
      // A scheme is optional; `*` matches zero characters.
      expect(match("secure.example.com", "/app")).toBe("https://secure.example.com/app*");
      expect(match("other.com", "/")).toBeUndefined();
    });

    it("derives the deployed origin of a pattern", () => {
      expect(routePatternUrl("api.example.com/users/*")).toBe("https://api.example.com");
      expect(routePatternUrl("http://api.example.com/*")).toBe("http://api.example.com");
      expect(routePatternUrl("*.example.com/*")).toBeUndefined();
    });
  },
);
