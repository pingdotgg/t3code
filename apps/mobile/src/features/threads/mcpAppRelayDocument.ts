import { MCP_APP_DOCUMENT_MESSAGE } from "@t3tools/shared/mcpApp";

// Android exposes `ReactNativeWebView` to every frame, so a frame nested in the
// app could post to React Native directly. The outer page therefore wraps what
// it relays with a secret only it holds, and React Native drops anything else.
// The relay also attests activation; the sandboxed app cannot set that flag.
export function mcpAppRelayDocument(src: string, allow: string, secret: string) {
  const attribute = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  // The frame's window outlives its document, so the relay trusts only the port the app
  // document's bootstrap sends first, and relays a message once that document confirms it is
  // alive. A frame whose app speaks before any handover was served without the bootstrap: the
  // relay reports it as unlinked and carries nothing in either direction.
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;background:transparent}iframe{border:0;display:block;width:100%;height:100%}</style></head>
<body><iframe id="app" sandbox="allow-scripts allow-forms" allow="${attribute(allow)}"></iframe>
<script>(function(){var frame=document.getElementById("app"),secret=${JSON.stringify(secret)},loads=0,live=true;
var send=function(m){var u=navigator.userActivation;window.ReactNativeWebView.postMessage(JSON.stringify({secret:secret,active:!!(u&&u.isActive)&&document.activeElement===frame,message:m}));};
frame.addEventListener("load",function(){loads+=1;if(loads>1&&live){live=false;send({t3:"navigated"});}});
var port=null,unconfirmed=Object.create(null),waiting=0,probe=0;
window.addEventListener("message",function(e){if(!live||e.source!==frame.contentWindow)return;
if(!port){if(e.data&&e.data.t3===${JSON.stringify(MCP_APP_DOCUMENT_MESSAGE)}&&e.ports[0]){port=e.ports[0];
port.onmessage=function(r){var k=r.data&&r.data.alive;if(live&&k in unconfirmed){var m=unconfirmed[k];delete unconfirmed[k];waiting-=1;send(m);}};}else if(e.data&&e.data.jsonrpc==="2.0"){live=false;send({t3:"unlinked"});}return;}
if(waiting<256){unconfirmed[probe]=e.data;waiting+=1;port.postMessage({alive:probe++});}});
window.__t3McpAppReceive=function(m){if(live&&port)port.postMessage({message:m,origin:location.origin});};
frame.src=${JSON.stringify(src).replace(/</g, "\\u003c")};})();</script></body></html>`;
}
