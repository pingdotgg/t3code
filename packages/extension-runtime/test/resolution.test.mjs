import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { resolveCapabilities } from "../dist/resolution.js";
const api = (id, version = "1.0.0") => ({ id, version, methods: [] });
const plugin = (id, dependencies = [], provides = [], requires = []) => ({
  id,
  enabled: true,
  package: { manifest: { version: "1.0.0" }, dependencies, provides, requires },
});
const dep = (pluginId, versionRange = "^1.0.0", apis = []) => ({ pluginId, versionRange, apis });
const status = (r, id) => r.plugins.find((p) => p.id === id);
NodeTest.test(
  "deterministic dependency-first order, missing/disabled/incompatible and transitive failure",
  () => {
    const a = plugin("example.a"),
      b = plugin("example.b", [dep(a.id)]),
      c = plugin("example.c", [dep(b.id)]);
    const expected = resolveCapabilities({ installations: [a, b, c] });
    NodeAssert.deepEqual(expected.order, [a.id, b.id, c.id]);
    NodeAssert.deepEqual(resolveCapabilities({ installations: [c, a, b] }), expected);
    NodeAssert.equal(
      status(resolveCapabilities({ installations: [b, c] }), b.id).reason.code,
      "missing-dependency",
    );
    NodeAssert.equal(
      status(resolveCapabilities({ installations: [{ ...a, enabled: false }, b, c] }), c.id).reason
        .code,
      "dependency-unavailable",
    );
    NodeAssert.equal(
      status(
        resolveCapabilities({ installations: [a, plugin("example.x", [dep(a.id, "^2")])] }),
        "example.x",
      ).reason.code,
      "incompatible-dependency",
    );
  },
);
NodeTest.test("full SCC plus transitive unavailable and selected provider cycles", () => {
  const a = plugin("example.a", [dep("example.b")]),
    b = plugin("example.b", [dep("example.a")]),
    c = plugin("example.c", [dep("example.a")]);
  const r = resolveCapabilities({ installations: [c, b, a] });
  NodeAssert.deepEqual(status(r, a.id).reason.relatedIds, [a.id, b.id]);
  NodeAssert.equal(status(r, c.id).reason.code, "dependency-unavailable");
  const x = plugin(
    "example.x",
    [],
    [api("example.x/api")],
    [{ id: "example.y/api", versionRange: "^1" }],
  );
  const y = plugin(
    "example.y",
    [],
    [api("example.y/api")],
    [{ id: "example.x/api", versionRange: "^1" }],
  );
  NodeAssert.equal(
    status(resolveCapabilities({ installations: [x, y] }), x.id).reason.code,
    "cyclic-dependency",
  );
});
NodeTest.test(
  "provider conflict, explicit selection, ordered authorized fallback and dependency API version",
  () => {
    const a = plugin("example.a", [], [api("t3.example/api")]),
      b = plugin("example.b", [], [api("t3.example/api")]),
      c = plugin("example.c", [], [], [{ id: "t3.example/api", versionRange: "^1" }]);
    NodeAssert.equal(
      status(resolveCapabilities({ installations: [a, b, c] }), c.id).reason.code,
      "provider-selection-required",
    );
    const selected = { id: "t3.example/api", providerId: a.id, fallbackProviderIds: [b.id] };
    NodeAssert.equal(
      resolveCapabilities({ installations: [a, b, c], selections: [selected] }).apis[0].providerId,
      a.id,
    );
    NodeAssert.equal(
      resolveCapabilities({
        installations: [{ ...a, enabled: false }, b, c],
        selections: [selected],
      }).apis[0].providerId,
      b.id,
    );
    const bad = plugin("example.bad", [
      dep(a.id, "^1", [{ id: "t3.example/api", versionRange: "^2" }]),
    ]);
    NodeAssert.equal(
      status(resolveCapabilities({ installations: [a, bad] }), bad.id).reason.code,
      "incompatible-api",
    );
  },
);
NodeTest.test(
  "strict semver rejects malformed ranges and honors prerelease opt-in, tilde and OR",
  () => {
    const a = plugin("example.a");
    a.package.manifest.version = "1.2.3-beta.1";
    const consumer = (range) => plugin("example.b", [dep(a.id, range)]);
    NodeAssert.equal(
      status(resolveCapabilities({ installations: [a, consumer("^1.0.0")] }), "example.b").reason
        .code,
      "incompatible-dependency",
    );
    NodeAssert.equal(
      status(
        resolveCapabilities({ installations: [a, consumer(">=1.2.3-beta.0 <2")] }),
        "example.b",
      ).status,
      "available",
    );
    for (const range of ["", "garbage"])
      NodeAssert.throws(
        () => resolveCapabilities({ installations: [a, consumer(range)] }),
        /range/,
      );
    a.package.manifest.version = "1.2.3+build";
    NodeAssert.equal(
      status(resolveCapabilities({ installations: [a, consumer("~1.2.0 || ^2")] }), "example.b")
        .status,
      "available",
    );
    NodeAssert.throws(() => resolveCapabilities({ installations: [a, a] }), /Duplicate/);
  },
);

NodeTest.test(
  "execution health preserves installed intent and reports failed plugin distinctly",
  () => {
    const a = plugin("example.a"),
      b = plugin("example.b", [dep(a.id)]);
    const result = resolveCapabilities({
      installations: [a, b],
      pluginHealth: { [a.id]: "failed" },
    });
    NodeAssert.equal(status(result, a.id).reason.code, "failed-plugin");
    NodeAssert.equal(status(result, b.id).reason.code, "dependency-unavailable");
    NodeAssert.equal(a.enabled, true);
    NodeAssert.equal(
      status(
        resolveCapabilities({ installations: [a], pluginHealth: { [a.id]: "starting" } }),
        a.id,
      ).status,
      "available",
    );
  },
);
