import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { vendor } from "./vendor-pstack.mjs";

NodeTest.test(
  "Given a pstack-t3 checkout, when it is vendored, then each skill lands without its front matter",
  (t) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "vendor-pstack-test-"));
    t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
    for (const skill of ["poteto-mode", "pstack-t3"]) {
      NodeFS.mkdirSync(NodePath.join(root, "checkout", "skills", skill), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(root, "checkout", "skills", skill, "SKILL.md"),
        `---\nname: ${skill}\ndescription: "x"\n---\n\n# ${skill} body\n\nText with --- inside.\n`,
      );
    }

    const written = vendor(NodePath.join(root, "checkout"), NodePath.join(root, "out"));

    NodeAssert.deepEqual(
      written.map((file) => NodePath.relative(root, file)),
      ["out/poteto-mode.md", "out/pstack-t3.md"],
    );
    NodeAssert.equal(
      NodeFS.readFileSync(written[0], "utf8"),
      "# poteto-mode body\n\nText with --- inside.\n",
    );
  },
);
