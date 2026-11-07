// Run with Node and evaluate its output in an isolated app's new-thread draft,
// with the scenario's Claude model selected. Submit through the normal composer;
// this preserves the real SDK lifecycle instead of seeding projection rows.
import * as NodeFS from "node:fs";

const scenario = JSON.parse(
  NodeFS.readFileSync(new URL("./scenario.json", import.meta.url), "utf8"),
);

console.log(`(() => {
  if (!location.pathname.startsWith('/draft/')) {
    throw new Error('Open a new thread draft in an isolated development app first.');
  }
  const composer = document.querySelector('[role="textbox"][aria-label="Message"]');
  if (!(composer instanceof HTMLElement) || !composer.isContentEditable) {
    throw new Error('The message composer is unavailable.');
  }
  composer.focus();
  document.execCommand('selectAll', false);
  document.execCommand('insertText', false, ${JSON.stringify(scenario.prompt)});
  return { seeded: composer.innerText === ${JSON.stringify(scenario.prompt)} };
})()`);
