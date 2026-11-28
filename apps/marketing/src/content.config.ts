import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { defineCollection } from "astro:content";
import type { Loader } from "astro/loaders";
import { z } from "astro/zod";

import { extractDocMeta, preprocessDocMarkdown } from "./lib/docsMarkdown.ts";

const docsUserLoader: Loader = {
  name: "t3code-user-docs",
  load: async ({ store, config, renderMarkdown, generateDigest, watcher }) => {
    const docsDir = NodePath.resolve(NodeURL.fileURLToPath(config.root), "../../docs/user");

    const loadFile = async (filename: string) => {
      const id = filename.replace(/\.md$/i, "");
      const filePath = NodePath.join(docsDir, filename);
      const raw = await NodeFSP.readFile(filePath, "utf8");
      const digest = generateDigest(raw);
      const existing = store.get(id);
      if (existing && existing.digest === digest) return;

      const meta = extractDocMeta(raw, id);
      const rendered = await renderMarkdown(preprocessDocMarkdown(raw), {
        fileURL: new URL(`file://${filePath}`),
      });

      store.set({
        id,
        data: { ...meta },
        body: raw,
        filePath: NodePath.relative(NodeURL.fileURLToPath(config.root), filePath),
        digest,
        rendered,
      });
    };

    const syncAll = async () => {
      const filenames = (await NodeFSP.readdir(docsDir)).filter((name) => name.endsWith(".md"));
      const validIds = new Set(filenames.map((name) => name.replace(/\.md$/i, "")));
      for (const existingId of store.keys()) {
        if (!validIds.has(existingId)) {
          store.delete(existingId);
        }
      }
      await Promise.all(filenames.map((name) => loadFile(name)));
    };

    await syncAll();

    if (watcher) {
      watcher.add(docsDir);
      const onFsEvent = async (changedPath: string) => {
        if (!changedPath.endsWith(".md")) return;
        if (NodePath.dirname(NodePath.resolve(changedPath)) !== docsDir) return;
        const name = NodePath.basename(changedPath);
        try {
          await loadFile(name);
        } catch {
          store.delete(name.replace(/\.md$/i, ""));
        }
      };
      watcher.on("add", onFsEvent);
      watcher.on("change", onFsEvent);
      watcher.on("unlink", (removedPath) => {
        if (NodePath.dirname(NodePath.resolve(removedPath)) !== docsDir) return;
        store.delete(NodePath.basename(removedPath).replace(/\.md$/i, ""));
      });
    }
  },
};

const docs = defineCollection({
  loader: docsUserLoader,
  schema: z.object({
    title: z.string(),
    description: z.string(),
  }),
});

export const collections = { docs };
