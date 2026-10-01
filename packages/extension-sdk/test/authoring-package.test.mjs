import React from "react";
import TestRenderer from "react-test-renderer";
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
const sdk = NodeURL.fileURLToPath(new URL("..", import.meta.url));
NodeTest.test(
  "external tarball: source, typed starter, generated entries, failed rebuild and receipt integrity",
  async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(process.env.T3_AUTHORING_PROOF_ROOT ?? NodeOS.tmpdir(), "t3-authoring-"),
    );
    const calls = [];
    function run(command, args, cwd, expected = 0) {
      const result = NodeChildProcess.spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, CI: "true" },
      });
      calls.push({ command, args, cwd, exitCode: result.status });
      if (result.status !== expected)
        throw new Error(
          command +
            " " +
            args.join(" ") +
            " exited " +
            result.status +
            "\n" +
            result.stdout +
            "\n" +
            result.stderr,
        );
      return result.stdout;
    }
    try {
      const packed = JSON.parse(
        run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], sdk),
      );
      const tarball = NodePath.join(root, packed[0].filename);
      const project = NodePath.join(root, "reader");
      run(process.execPath, [NodePath.join(sdk, "bin/t3-extension.mjs"), "create", project], root);
      const packagePath = NodePath.join(project, "package.json"),
        pkg = JSON.parse(await NodeFSP.readFile(packagePath, "utf8"));
      pkg.devDependencies["@t3tools/extension-sdk"] = "file:" + tarball;
      await NodeFSP.writeFile(packagePath, JSON.stringify(pkg, null, 2));
      run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], project);
      const installed = NodePath.join(project, "node_modules/@t3tools/extension-sdk");
      for (const f of [
        "src/authoring.ts",
        "src/capabilities.ts",
        "test/authoring.test.mjs",
        "examples/start-here/extension.ts",
      ])
        await NodeFSP.access(NodePath.join(installed, f));
      run("npm", ["run", "build"], project);
      run("npm", ["run", "check"], project);
      const output = NodePath.join(project, ".t3-extension");
      const receipt = JSON.parse(
        await NodeFSP.readFile(NodePath.join(output, "receipt.json"), "utf8"),
      );
      NodeAssert.equal(receipt.installed, false);
      NodeAssert.equal(receipt.packageId, "example.readme");
      for (const [f, hash] of Object.entries(receipt.hashes))
        NodeAssert.equal(
          NodeCrypto.createHash("sha256")
            .update(await NodeFSP.readFile(NodePath.join(output, f)))
            .digest("hex"),
          hash,
        );
      const sourcePath = NodePath.join(project, "extension.ts"),
        source = await NodeFSP.readFile(sourcePath, "utf8");
      await NodeFSP.writeFile(
        sourcePath,
        source.replace('relativePath: "README.md"', 'wrongField: "README.md"'),
      );
      run("npm", ["run", "build"], project, 1);
      NodeAssert.deepEqual(
        JSON.parse(await NodeFSP.readFile(NodePath.join(output, "receipt.json"), "utf8")),
        receipt,
      );
      await NodeFSP.writeFile(sourcePath, source);
      run("npm", ["run", "build"], project);
      await NodeFSP.appendFile(NodePath.join(output, "client.mjs"), "\n// changed after receipt\n");
      run("npm", ["run", "check"], project, 1);
      run("npm", ["run", "build"], project);
      run("npm", ["run", "check"], project);
      // An ordinary dependency may initialize context at import time and use imported hooks.
      await NodeFSP.writeFile(
        NodePath.join(project, "component.ts"),
        [
          'import { createContext, createElement, useContext, useState } from "react";',
          'import { jsx } from "react/jsx-runtime";',
          'const Context = createContext("shared");',
          "export function Component() { const [n, set] = useState(0); const label = useContext(Context);",
          'return jsx("button", { onClick: () => set(n + 1), children: label + n }); }',
        ].join("\n"),
      );
      await NodeFSP.writeFile(
        sourcePath,
        [
          'import { defineExtension } from "@t3tools/extension-sdk/authoring";',
          'import { Component } from "./component.js";',
          'export default defineExtension({id:"test.shared-react",version:"1.0.0",surfaces:[{',
          'name:"view",title:"Shared React",scope:"project",createView(){return {renderer:Component};}}]});',
        ].join("\n"),
      );
      run("npm", ["run", "build"], project);
      run("npm", ["run", "check"], project);
      const factory = (
        await import(NodeURL.pathToFileURL(NodePath.join(output, "client.mjs")).href)
      ).default;
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      let mounted;
      const surface = factory({ React }).surfaces[0];
      const Component = surface.createView({}).renderer;
      await TestRenderer.act(async () => {
        mounted = TestRenderer.create(React.createElement(Component));
      });
      NodeAssert.equal(mounted.toJSON().children[0], "shared0");
      await TestRenderer.act(async () => {
        mounted.root.findByType("button").props.onClick();
      });
      NodeAssert.equal(mounted.toJSON().children[0], "shared1");
      await TestRenderer.act(async () => {
        mounted.unmount();
      });
      await NodeFSP.writeFile(sourcePath, source);
      run("npm", ["run", "build"], project);
      const provider = NodePath.join(root, "provider");
      await NodeFSP.mkdir(provider);
      await NodeFSP.cp(NodePath.join(installed, "examples/api-provider"), provider, {
        recursive: true,
      });
      await NodeFSP.copyFile(packagePath, NodePath.join(provider, "package.json"));
      // Intentionally exclude server.ts; build must nevertheless check it.
      await NodeFSP.writeFile(
        NodePath.join(provider, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: true,
          },
          include: ["extension.ts"],
        }),
      );
      run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], provider);
      run("npm", ["run", "build"], provider);
      const serverPath = NodePath.join(provider, "server.ts"),
        server = await NodeFSP.readFile(serverPath, "utf8");
      await NodeFSP.writeFile(
        serverPath,
        server.replace(
          'return { message: "Hello from the provider" };',
          'const invalid: number = "not a number"; return { message: String(invalid) };',
        ),
      );
      run("npm", ["run", "build"], provider, 1);
      await NodeFSP.writeFile(serverPath, server);
      run("npm", ["run", "build"], provider);
      run("npm", ["run", "check"], provider);
      const pair = NodePath.join(root, "pair");
      for (const name of ["api-provider", "api-consumer"]) {
        const location = NodePath.join(pair, name);
        await NodeFSP.cp(NodePath.join(installed, "examples", name), location, { recursive: true });
        await NodeFSP.copyFile(packagePath, NodePath.join(location, "package.json"));
        await NodeFSP.copyFile(
          NodePath.join(project, "tsconfig.json"),
          NodePath.join(location, "tsconfig.json"),
        );
        run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], location);
        run("npm", ["run", "build"], location);
        run("npm", ["run", "check"], location);
      }
      await NodeFSP.writeFile(
        NodePath.join(root, "receipt.json"),
        JSON.stringify(
          {
            kind: "external-package-test",
            installed: false,
            tarball,
            calls,
            checks: [
              "source and tests shipped",
              "typed starter builds independently",
              "imported hooks, module context and JSX use host React in external package",
              "receipt hashes match",
              "wrong input rejected; prior output retained",
              "changed output rejected; rebuild recovers",
              "declared server typechecked despite config exclusion",
            ],
          },
          null,
          2,
        ),
      );
      console.log("Authoring artifact: " + root);
    } finally {
      await NodeFSP.writeFile(NodePath.join(root, "commands.json"), JSON.stringify(calls, null, 2));
    }
  },
);
