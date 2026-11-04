import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  PLUGIN_VIEW_BOOTSTRAP_SHA256,
  PLUGIN_VIEW_BOOTSTRAP_SOURCE,
  buildPluginViewDocument,
} from "./viewDocument.ts";

/** Base64 SHA-256 of the UTF-8 bytes, as a CSP hash source spells it. */
const sha256 = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) => btoa(String.fromCharCode(...new Uint8Array(digest)))),
  );

const script = `t3View.ready.then((view) => { document.body.textContent = view.title + " & \\"ok\\""; });\n`;
const style = "body { color: red; }\n";
const makeBundle = Effect.gen(function* () {
  return {
    script: { text: script, sha256: yield* sha256(script) },
    style: { text: style, sha256: yield* sha256(style) },
  };
});

/** What the HTML parser makes of a double-quoted attribute value written by the builder. */
const parseAttribute = (value: string) => value.replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("buildPluginViewDocument", () => {
  it.effect("pins the host bootstrap's hash and keeps it inlinable", () =>
    Effect.gen(function* () {
      expect(PLUGIN_VIEW_BOOTSTRAP_SHA256).toBe(yield* sha256(PLUGIN_VIEW_BOOTSTRAP_SOURCE));
      expect(PLUGIN_VIEW_BOOTSTRAP_SOURCE).not.toMatch(/<\/script|<!--|<script|[\r\0]/i);
    }),
  );

  it.effect("puts the view, byte for byte, inside a script-free policy wrapper", () =>
    Effect.gen(function* () {
      const bundle = yield* makeBundle;
      const wrapper = Result.getOrThrow(buildPluginViewDocument(bundle, "Board <1>"));
      const policy = `default-src 'none'; script-src 'sha256-${PLUGIN_VIEW_BOOTSTRAP_SHA256}' 'sha256-${bundle.script.sha256}'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'`;
      const head = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}">`;
      // The wrapper's own policy comes first and it runs no script.
      expect(wrapper.startsWith(head)).toBe(true);
      const [outer, srcdoc] = wrapper.split(' srcdoc="');
      expect(outer).not.toContain("<script");
      expect(outer).toContain(
        '<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" allow=""',
      );
      expect(outer).toContain("<title>Board &#60;1&#62;</title>");

      const view = parseAttribute(srcdoc!.slice(0, srcdoc!.lastIndexOf('"></iframe>')));
      expect(view.startsWith(head)).toBe(true);
      // Each script element's text is exactly the hashed source.
      const scripts = [...view.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
      expect(scripts).toEqual([PLUGIN_VIEW_BOOTSTRAP_SOURCE, script]);
      const hashes: Array<string> = [];
      for (const text of scripts) hashes.push(yield* sha256(text));
      expect(hashes).toEqual([PLUGIN_VIEW_BOOTSTRAP_SHA256, bundle.script.sha256]);
      expect(view).toContain(`<style>${style}</style>`);
    }),
  );

  it.effect("refuses bundles whose text the parser would change", () =>
    Effect.gen(function* () {
      const bundle = yield* makeBundle;
      for (const text of ["a</script>b", "<!-- x", "a\r\nb", "﻿a", "a\0b"]) {
        const built = buildPluginViewDocument(
          { script: { text, sha256: bundle.script.sha256 }, style: null },
          "View",
        );
        expect(Result.isFailure(built)).toBe(true);
      }
      for (const text of ["a</STYLE>b", "\uFEFFa"]) {
        const style = { text, sha256: bundle.style.sha256 };
        expect(
          Result.isFailure(buildPluginViewDocument({ script: bundle.script, style }, "View")),
        ).toBe(true);
      }
    }),
  );
});
