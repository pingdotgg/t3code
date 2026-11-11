import type { HtmlRenderTheme } from "@t3tools/shared/htmlRender";

export interface ExtensionPanelContext {
  readonly threadId?: string;
  readonly projectId?: string;
  readonly surface: "web" | "desktop" | "mobile";
}

export function extensionPanelDocument(
  html: string,
  context: ExtensionPanelContext,
  channel: string,
  theme: HtmlRenderTheme,
  settings: Readonly<Record<string, unknown>>,
) {
  const data = JSON.stringify({ context, channel, theme, settings }).replaceAll("<", "\\u003c");
  const script = `<script>(()=>{
const config=${data};let next=0;const pending=new Map();const themeListeners=new Set();const settingsListeners=new Set();
const send=message=>{if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(message));else window.parent.postMessage(message,'*');};
const applyTheme=theme=>{config.theme=theme;document.documentElement.style.colorScheme=theme.appearance;for(const [key,value]of Object.entries(theme.variables))document.documentElement.style.setProperty(key,value);};
const request=(operation,input,command)=>new Promise((resolve,reject)=>{const requestId=++next;const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('Extension request timed out.'));},65000);pending.set(requestId,{resolve,reject,timer});send({type:'t3-extension-request',channel:config.channel,requestId,operation,command,input});});
window.t3Extension={context:config.context,get theme(){return config.theme;},get settings(){return config.settings;},call:(command,input=null)=>request('command',input,command),updateSettings:patch=>request('settings.update',patch),onThemeChanged(listener){themeListeners.add(listener);return()=>themeListeners.delete(listener);},onSettingsChanged(listener){settingsListeners.add(listener);return()=>settingsListeners.delete(listener);}};
applyTheme(config.theme);
window.addEventListener('message',event=>{let message=event.data;if(typeof message==='string'){try{message=JSON.parse(message);}catch{return;}}if(!message||message.channel!==config.channel)return;
if(message.type==='t3-extension-state'){if(message.theme){applyTheme(message.theme);for(const listener of themeListeners)listener(config.theme);}if(message.settings){config.settings=message.settings;for(const listener of settingsListeners)listener(config.settings);}return;}
if(message.type!=='t3-extension-response')return;const waiting=pending.get(message.requestId);if(!waiting)return;pending.delete(message.requestId);clearTimeout(waiting.timer);if(message.error)waiting.reject(new Error(message.error));else waiting.resolve(message.result);});
window.addEventListener('pagehide',()=>{for(const waiting of pending.values()){clearTimeout(waiting.timer);waiting.reject(new Error('Extension panel closed.'));}pending.clear();});
})();</script>`;
  if (/<head\b[^>]*>/i.test(html))
    return html.replace(/<head\b[^>]*>/i, (head) => `${head}${script}`);
  if (/<html\b[^>]*>/i.test(html))
    return html.replace(/<html\b[^>]*>/i, (root) => `${root}<head>${script}</head>`);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? `${doctype[0]}${script}${html.slice(doctype[0].length)}` : `${script}${html}`;
}

export function extensionPanelRequest(
  value: unknown,
  channel: string,
): {
  requestId: number;
  operation: "command" | "settings.update";
  command?: string;
  input: unknown;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  if (
    message.type !== "t3-extension-request" ||
    message.channel !== channel ||
    !Number.isSafeInteger(message.requestId)
  )
    return null;
  if (message.operation === "settings.update")
    return {
      requestId: Number(message.requestId),
      operation: "settings.update",
      input: message.input,
    };
  if (message.operation === "command" && typeof message.command === "string")
    return {
      requestId: Number(message.requestId),
      operation: "command",
      command: message.command,
      input: message.input,
    };
  return null;
}

function extensionSettingsPatch(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Settings must be an object.");
  return value as Record<string, unknown>;
}

export async function extensionPanelResponse(
  request: NonNullable<ReturnType<typeof extensionPanelRequest>>,
  host: {
    command: (name: string, input: unknown) => Promise<unknown>;
    settings: (patch: Record<string, unknown>) => Promise<unknown>;
  },
): Promise<{ result: unknown } | { error: string }> {
  try {
    return {
      result:
        request.operation === "settings.update"
          ? await host.settings(extensionSettingsPatch(request.input))
          : await host.command(request.command!, request.input),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Extension request failed." };
  }
}
