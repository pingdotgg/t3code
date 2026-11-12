import {
  parseCreatedAt,
  parseRepoDigest,
  publishedRepoDigest,
  repositoryFromImageRef,
  withRegistryHost,
} from "@alchemy.run/docker/Registry";
import { describe, expect, it } from "@alchemy.run/test";

const digest = `sha256:${"a".repeat(64)}`;
const other = `sha256:${"b".repeat(64)}`;

describe(
  "repositoryFromImageRef",
  { tags: ["unit", "provider:docker", "provider:docker:registry", "local"] },
  () => {
    it("strips a simple tag", () => {
      expect(repositoryFromImageRef("nginx:alpine")).toBe("nginx");
    });

    it("keeps the registry host and path", () => {
      expect(repositoryFromImageRef("ghcr.io/acme/app:latest")).toBe("ghcr.io/acme/app");
    });

    it("does not confuse a registry port for a tag", () => {
      expect(repositoryFromImageRef("localhost:5000/acme/app:latest")).toBe(
        "localhost:5000/acme/app",
      );
    });

    it("strips a digest", () => {
      expect(
        repositoryFromImageRef(
          "localhost:5000/acme/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
      ).toBe("localhost:5000/acme/app");
    });

    it("returns a bare repository unchanged", () => {
      expect(repositoryFromImageRef("nginx")).toBe("nginx");
    });
  },
);

describe(
  "withRegistryHost",
  { tags: ["unit", "provider:docker", "provider:docker:registry", "local"] },
  () => {
    it("prefixes a bare reference with the registry host", () => {
      expect(withRegistryHost("app:latest", { server: "ghcr.io" })).toBe("ghcr.io/app:latest");
    });

    it("trims a trailing slash from the server", () => {
      expect(withRegistryHost("app:latest", { server: "ghcr.io/" })).toBe("ghcr.io/app:latest");
    });

    it("leaves a reference that already has a dotted-host prefix", () => {
      expect(withRegistryHost("registry.example.com/app:latest", { server: "ghcr.io" })).toBe(
        "registry.example.com/app:latest",
      );
    });

    it("leaves a localhost:port reference untouched", () => {
      expect(withRegistryHost("localhost:5000/app:latest", { server: "ghcr.io" })).toBe(
        "localhost:5000/app:latest",
      );
    });
  },
);

describe(
  "parseRepoDigest",
  { tags: ["unit", "provider:docker", "provider:docker:registry", "local"] },
  () => {
    it("extracts the repo digest from push output", () => {
      expect(
        parseRepoDigest(
          "localhost:5000/app:latest",
          "latest: digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa size: 123",
        ),
      ).toBe(
        "localhost:5000/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      );
    });

    it("returns undefined when no digest is present", () => {
      expect(parseRepoDigest("app:latest", "Pushed without a digest")).toBe(undefined);
    });
  },
);

describe(
  "publishedRepoDigest",
  { tags: ["unit", "provider:docker", "provider:docker:registry", "local"] },
  () => {
    it("reads RepoDigests when push output has no digest line", () => {
      expect(
        publishedRepoDigest(
          "localhost:5055/app:latest",
          {
            stdout: "",
            stderr:
              "Getting image source signatures\nCopying blob sha256:74d97c42\nWriting manifest to image destination\n",
          },
          [`localhost:5055/app@${digest}`, `ghcr.io/acme/app@${other}`],
        ),
      ).toBe(`localhost:5055/app@${digest}`);
    });

    it("prefers a digest line from push output", () => {
      expect(
        publishedRepoDigest(
          "localhost:5055/app:latest",
          { stdout: `latest: digest: ${digest}`, stderr: "" },
          [`localhost:5055/app@${other}`],
        ),
      ).toBe(`localhost:5055/app@${digest}`);
    });

    it("uses the registry-qualified RepoDigests entry", () => {
      expect(
        publishedRepoDigest(
          "app:latest",
          { stdout: "", stderr: "" },
          [`ghcr.io/acme/app@${digest}`],
          "ghcr.io/acme/app:latest",
        ),
      ).toBe(`ghcr.io/acme/app@${digest}`);
    });

    it("returns undefined when neither output nor RepoDigests match", () => {
      expect(
        publishedRepoDigest("app:latest", { stdout: "", stderr: "Writing manifest\n" }, [
          `ghcr.io/acme/other@${digest}`,
        ]),
      ).toBe(undefined);
    });
  },
);

describe(
  "parseCreatedAt",
  { tags: ["unit", "provider:docker", "provider:docker:registry", "local"] },
  () => {
    it("parses an RFC 3339 timestamp", () => {
      const created = "2026-06-22T20:53:00.395Z";
      expect(parseCreatedAt(created)).toBe(Date.parse(created));
    });

    it("falls back to the wall clock when omitted", () => {
      const before = Date.now();
      const result = parseCreatedAt(undefined);
      expect(result).toBeGreaterThanOrEqual(before);
    });

    it("falls back to the wall clock for an empty string", () => {
      const before = Date.now();
      expect(parseCreatedAt("")).toBeGreaterThanOrEqual(before);
    });

    it("falls back to the wall clock for the year-1 zero value", () => {
      const before = Date.now();
      expect(parseCreatedAt("0001-01-01T00:00:00Z")).toBeGreaterThanOrEqual(before);
    });
  },
);
