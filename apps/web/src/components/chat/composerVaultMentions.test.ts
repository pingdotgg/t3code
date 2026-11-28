import { expect, it } from "vite-plus/test";
import { collectVaultMentions } from "@t3tools/contracts";
import { formatVaultMention, matchVaultMentions } from "./composerVaultMentions";
import { splitPromptIntoComposerSegments } from "../../composer-editor-mentions";

it("ranks matching vault names without including secret fields or vault identifiers in the draft", () => {
  const entries = [
    {
      name: "entry-first",
      title: "Work Gmail",
      origin: "https://example.test",
      username: "dummy@example.test",
      password: "fixture-password",
    },
    { name: "entry-second", title: "Gmail" },
    { name: "entry-third", title: "GitHub" },
  ];
  const items = matchVaultMentions(entries, "gMaIl");
  expect(items).toEqual([
    { id: "vault-credential:entry-second", label: "Gmail", type: "vault-credential" },
    { id: "vault-credential:entry-first", label: "Work Gmail", type: "vault-credential" },
  ]);
  expect(items.map(({ label }) => formatVaultMention(label))).toEqual([
    'vault:"Gmail"',
    'vault:"Work Gmail"',
  ]);
});

it("keeps names with line breaks or quotes inside one label", () => {
  const [item] = matchVaultMentions([{ name: "entry-1", title: 'Mail\n"Work"' }], "mail");
  const source = formatVaultMention(item!.label);
  expect(source).toBe('vault:"Mail \\"Work\\""');
  expect(splitPromptIntoComposerSegments(`Use ${source} please`)).toEqual([
    { type: "text", text: "Use " },
    { type: "vault-credential", label: 'Mail "Work"', source },
    { type: "text", text: " please" },
  ]);
  expect(collectVaultMentions('notvault:"Gmail" vault:"unfinished')).toEqual([]);
});
