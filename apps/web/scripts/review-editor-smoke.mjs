import * as NodeAssert from "node:assert/strict";
import * as NodeModule from "node:module";

const { chromium } = NodeModule.createRequire(
  new URL("../../desktop/package.json", import.meta.url),
)("playwright-core");
const origin = new URL(process.argv[2]);
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
try {
  for (const platform of ["Linux x86_64", "MacIntel"]) {
    for (const diffStyle of ["unified", "split"]) {
      const page = await browser.newPage();
      await page.addInitScript((value) => {
        Object.defineProperty(navigator, "platform", { get: () => value });
      }, platform);
      await page.route("**/review-editor-smoke", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><body><input aria-label="Outside editor"><div id="view" style="height:600px;overflow:auto"></div><script type="module">
import { CodeView, parseDiffFromFile } from '/node_modules/.vite/deps/@pierre_diffs.js';
import { Editor } from '/node_modules/.vite/deps/@pierre_diffs_editor.js';
const contents = 'const first = 1;\\nconst second = first;\\nconst third = first;\\n';
window.editors = [];
const view = new CodeView({diffStyle:${JSON.stringify(diffStyle)},overflow:'wrap',createEditor:options=>{const editor=new Editor(options);editors.push(editor);return editor;}});
window.view = view;
view.setup(document.getElementById('view'));
view.setItems(['one.ts','two.ts'].map(name=>({id:name,type:'diff',version:1,edit:true,fileDiff:parseDiffFromFile({name,contents:contents.replace('= 1','= 0')},{name,contents})})));
</script></body></html>`,
        }),
      );
      await page.goto(new URL("/review-editor-smoke", origin).href);
      const frame = () =>
        page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      const contents = (name) =>
        page.evaluate(
          (value) =>
            window.editors.find((editor) => editor.getFile().name === value).getFile().contents,
          name,
        );
      const addedLine = (name) =>
        page.locator(`[aria-label="${name}"] [data-line-type="change-addition"]`).first();
      await addedLine("one.ts").waitFor();
      NodeAssert.equal((await contents("one.ts")).split("\n").length, 4);
      await page.evaluate(() =>
        document.addEventListener(
          "pointerdown",
          () => {
            window.view.setOptions({ ...window.view.options, themeType: "dark" });
            window.view.render(true);
          },
          { once: true },
        ),
      );
      await addedLine("one.ts").click({ position: { x: 60, y: 8 } });
      await page.keyboard.type("a");
      NodeAssert.match(await contents("one.ts"), /fairst/);
      await addedLine("two.ts").click({ position: { x: 60, y: 8 } });
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await frame();
      await frame();
      await page.keyboard.type("AFTER_ENTER");
      NodeAssert.match(await contents("two.ts"), /;\nAFTER_ENTER\n/);
      await page.keyboard.press("Home");
      await page.keyboard.press("Backspace");
      await frame();
      await frame();
      await page.keyboard.type("AFTER_BACKSPACE");
      NodeAssert.match(await contents("two.ts"), /;AFTER_BACKSPACEAFTER_ENTER\n/);
      await page.evaluate(() => {
        window.editors.find((editor) => editor.getFile().name === "two.ts").focus();
        document.querySelector("input").focus();
      });
      await frame();
      await page.keyboard.type("outside");
      NodeAssert.equal(await page.getByLabel("Outside editor").inputValue(), "outside");
      await addedLine("two.ts").click({ position: { x: 60, y: 8 } });
      await page.evaluate(() =>
        window.editors
          .find((editor) => editor.getFile().name === "two.ts")
          .setSelections([
            { start: { line: 1, character: 16 }, end: { line: 1, character: 16 }, direction: 0 },
          ]),
      );
      await frame();
      const modifier = platform === "MacIntel" ? "Meta" : "Control";
      await page.keyboard.press(`${modifier}+d`);
      await page.keyboard.press(`${modifier}+d`);
      await page.keyboard.type("renamed");
      NodeAssert.match(await contents("two.ts"), /const second = renamed;\nconst third = renamed;/);
      await page.keyboard.press(`${modifier}+f`);
      await page.getByPlaceholder("Search", { exact: true }).fill("renamed");
      NodeAssert.equal(
        await page.getByPlaceholder("Search", { exact: true }).inputValue(),
        "renamed",
      );
      await page.keyboard.press("Escape");
      NodeAssert.equal(await page.getByPlaceholder("Search", { exact: true }).count(), 0);
      NodeAssert.match(await contents("one.ts"), /fairst/);
      const reactDom = await page.request.get(
        new URL("/node_modules/.vite/deps/react-dom_client.js", origin).href,
      );
      const reactUrl = (await reactDom.text()).match(/from "([^"\n]*\/react\.js[^"\n]*)"/)?.[1];
      NodeAssert.ok(reactUrl);
      await page.route("**/review-editor-partial", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><body><input aria-label="Outside editor"><div id="view" style="height:600px"></div><script type="module">
import React from '${reactUrl}';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import { CodeView } from '/node_modules/.vite/deps/@pierre_diffs_react.js';
import { hydratePartialDiff, parsePatchFiles } from '/node_modules/.vite/deps/@pierre_diffs.js';
import { Editor } from '/node_modules/.vite/deps/@pierre_diffs_editor.js';
const contents = Array.from({length:3527},(_,i)=>'const line'+(i+1)+' = '+(i+1)+';\\n').join('');
const initial = ['one.ts','two.ts'].map(name=>({id:name,type:'diff',version:1,fileDiff:parsePatchFiles([
'diff --git a/'+name+' b/'+name,'--- a/'+name,'+++ b/'+name,'@@ -725,6 +725,7 @@',...Array.from({length:3},(_,i)=>' const line'+(725+i)+' = '+(725+i)+';'),
'+const added = true;',...Array.from({length:3},(_,i)=>' const line'+(728+i)+' = '+(728+i)+';'),
'@@ -868,6 +869,7 @@',...Array.from({length:3},(_,i)=>' const line'+(868+i)+' = '+(868+i)+';'),
'+const second = true;',...Array.from({length:3},(_,i)=>' const line'+(871+i)+' = '+(871+i)+';'),''
].join('\\n'))[0].files[0]}));
window.editors = [];
function App() {
  const [items,setItems] = React.useState(initial);
  const [dirty,setDirty] = React.useState(false);
  window.hydrate = () => setItems(items.map(item=>({...item,version:2,edit:true,fileDiff:hydratePartialDiff('clone',item.fileDiff,{oldFile:{name:item.id,contents},newFile:{name:item.id,contents:contents.replace('const line728','const added = true;\\nconst line728').replace('const line871','const second = true;\\nconst line871')}})})));
  return React.createElement(CodeView,{items:items.map(item=>({...item})),disableWorkerPool:true,style:{height:'100%',overflow:'auto'},
    createEditor:options=>{const editor=new Editor(options);editors.push(editor);return editor;},
    onItemEditChange:()=>setDirty(true),renderHeaderFilenameSuffix:()=>dirty?'●':null,
    options:{diffStyle:${JSON.stringify(diffStyle)},overflow:'wrap',itemMetrics:{diffHeaderHeight:32,hunkSeparatorHeight:24,spacing:0,paddingTop:0,paddingBottom:8},layout:{paddingTop:0,paddingBottom:0,gap:0},unsafeCSS:'[data-diffs-header]{min-height:32px!important;padding-block:6px!important}[data-separator="line-info"]{height:24px!important;margin-block:0!important}'}});
}
ReactDOM.createRoot(document.getElementById('view')).render(React.createElement(App));
</script></body></html>`,
        }),
      );
      await page.goto(new URL("/review-editor-partial", origin).href);
      await page.waitForFunction(() => typeof window.hydrate === "function");
      await page.evaluate(() => window.hydrate());
      await addedLine("one.ts").click({ position: { x: 60, y: 8 } });
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await frame();
      await frame();
      await page.keyboard.type("AFTER_ENTER");
      NodeAssert.match(await contents("one.ts"), /;\nAFTER_ENTER\n/);
      await page.keyboard.press("Home");
      await page.keyboard.press("Backspace");
      await frame();
      await frame();
      await page.keyboard.type("AFTER_BACKSPACE");
      NodeAssert.match(await contents("one.ts"), /;AFTER_BACKSPACEAFTER_ENTER\n/);
      await page.getByLabel("Outside editor").click();
      await page.keyboard.type("outside");
      NodeAssert.equal(await page.getByLabel("Outside editor").inputValue(), "outside");
      console.log(
        `${platform} ${diffStyle}: typing, line edits, focus, find, multi-selection, and controlled partial diffs passed`,
      );
      await page.close();
    }
  }
} finally {
  await browser.close();
}
