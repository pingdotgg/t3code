// This document is installed once. Updates reconcile runs so streaming does not
// reload the WebView or recreate completed equations and open source disclosures.
export const NATIVE_MATH_DOCUMENT = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:"><style>
mjx-assistive-mml{position:absolute!important;clip:rect(1px,1px,1px,1px);padding:1px 0 0 0!important;border:0!important;display:block!important;width:auto!important;overflow:hidden!important;user-select:none!important}*{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent}body{font-family:-apple-system,system-ui,sans-serif;overflow-wrap:anywhere}#content{white-space:pre-wrap}a{color:inherit}.inline-icon{display:inline-block;width:14px;height:14px;vertical-align:-2px;margin-right:4px;user-select:none;-webkit-user-select:none}.display{display:block;margin:1em 0;min-width:0;white-space:normal}.viewport{display:block;overflow-x:auto;padding:.5em 0}.display .equation{display:block;width:max-content;min-width:100%;text-align:center}.equation{white-space:nowrap}.equation mjx-container{margin:0!important;direction:ltr}.equation svg{overflow:visible;min-width:1px;min-height:1px}.display .equation mjx-container{display:block;line-height:0}.display .equation svg{display:block;margin-inline:auto}.actions{display:flex;justify-content:flex-end;gap:14px;user-select:none;-webkit-user-select:none}button{font:12px system-ui;color:inherit;background:none;border:0;padding:6px 0}.source{display:block;white-space:pre-wrap;font:12px monospace;margin-top:8px}.source[hidden]{display:none}.file-menu{display:flex;flex-direction:column;align-items:flex-start;white-space:normal;border-block:1px solid currentColor;padding:4px 0}.file-actions{padding-inline:5px}button:focus-visible,.viewport:focus-visible{outline:1px solid currentColor}
</style></head><body><div id="content"></div><script>
(function(){
var revision=0, previous=[], root=document.getElementById('content');
function send(data){window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({revision:revision},data)));}
window.mathCopyResult=function(text){document.querySelectorAll('[data-copy]').forEach(function(button){if(button.getAttribute('data-copy')===text)button.textContent='Copied';});};
function measure(){send({type:'height',height:Math.ceil(document.body.getBoundingClientRect().height)});}
window.updateMath=function(update){
revision=update.revision;document.body.style.color=update.color;document.body.style.fontSize=update.fontSize+'px';document.body.style.lineHeight=update.lineHeight+'px';
update.runs.forEach(function(html,index){if(previous[index]===html)return;var child=root.children[index];if(!child){child=document.createElement('span');root.appendChild(child);}child.innerHTML=html;});
while(root.children.length>update.runs.length)root.lastElementChild.remove();previous=update.runs;measure();
};
new ResizeObserver(measure).observe(document.body);
document.addEventListener('keydown',function(event){if(event.key==='Escape'){var menu=document.querySelector('.file-menu');if(menu)menu.remove();}});
document.addEventListener('click',function(event){var old=document.querySelector('.file-menu');var target=event.target.closest('button,a');if(!target){if(old)old.remove();return;}
if(target.hasAttribute('data-menu')){var closing=old&&target.nextElementSibling===old;if(old)old.remove();if(closing)return;var menu=JSON.parse(target.getAttribute('data-menu'));var list=document.createElement('span');list.className='file-menu';list.setAttribute('role','menu');menu.actions.forEach(function(action){var button=document.createElement('button');button.textContent=action.title;button.disabled=!!action.disabled;button.setAttribute('role','menuitem');button.setAttribute('data-href',target.getAttribute('data-href'));button.setAttribute('data-action',action.id);list.appendChild(button);});target.after(list);return;}
if(target.hasAttribute('data-action')){send({type:'file-action',href:target.getAttribute('data-href'),action:target.getAttribute('data-action')});target.closest('.file-menu').remove();return;}
if(old)old.remove();
if(target.hasAttribute('data-copy')){send({type:'copy',text:target.getAttribute('data-copy')});return;}
if(target.hasAttribute('data-toggle')){var source=target.closest('.display').querySelector('.source');source.hidden=!source.hidden;target.textContent=source.hidden?'TeX source':'Hide source';target.setAttribute('aria-expanded',String(!source.hidden));return;}
if(target.tagName==='A'){event.preventDefault();send({type:'link',href:target.getAttribute('href')});}
});
document.addEventListener('copy',function(event){var selection=window.getSelection();if(!selection||!selection.rangeCount||selection.isCollapsed)return;
var range=selection.getRangeAt(0).cloneRange();function math(node){return (node.nodeType===1?node:node.parentElement).closest('.equation,[data-copy-source]');}
var start=math(range.startContainer),end=math(range.endContainer);if(start)range.setStartBefore(start);if(end)range.setEndAfter(end);
var fragment=document.createElement('div');fragment.appendChild(range.cloneContents());fragment.querySelectorAll('.actions,.source,.file-actions,.file-menu,.inline-icon').forEach(function(node){node.remove();});fragment.querySelectorAll('[data-copy-source]').forEach(function(node){node.replaceWith(document.createTextNode(node.getAttribute('data-copy-source')));});fragment.querySelectorAll('.equation').forEach(function(node){node.replaceWith(document.createTextNode(node.getAttribute('data-source')));});
event.preventDefault();send({type:'copy',text:fragment.textContent});
});
send({type:'ready'});
})();
</script></body></html>`;
