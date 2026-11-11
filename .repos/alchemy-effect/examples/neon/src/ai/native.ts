import { neon } from "@neon/ai-sdk-provider";
import { streamText } from "ai";

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(page, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    if (url.pathname !== "/chat" || request.method !== "POST")
      return new Response("Not found", { status: 404 });
    if (
      !process.env.EXAMPLE_API_KEY ||
      request.headers.get("authorization") !== `Bearer ${process.env.EXAMPLE_API_KEY}`
    ) {
      return new Response("Unauthorized", { status: 401 });
    }
    const input = await request.json().catch(() => undefined);
    if (
      !input ||
      typeof input.prompt !== "string" ||
      input.prompt.trim().length === 0 ||
      input.prompt.length > 4000
    )
      return new Response("Expected a prompt of at most 4000 characters", {
        status: 400,
      });
    if (process.env.AI_ALLOW_PAID !== "true")
      return new Response("Paid inference is disabled. Set NEON_AI_ALLOW_PAID=true explicitly.", {
        status: 503,
      });
    if (!process.env.AI_MODEL)
      return new Response("Configure NEON_AI_MODEL before deployment.", {
        status: 503,
      });
    const result = streamText({
      model: neon(process.env.AI_MODEL),
      prompt: input.prompt,
      maxOutputTokens: 128,
      maxRetries: 0,
      abortSignal: request.signal,
    });
    return result.toUIMessageStreamResponse({
      onError: () =>
        "Gateway rejected the request. Check model access, paid-plan entitlement and prepaid credits. No credits were purchased.",
    });
  },
};

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Neon AI Gateway</title>
<style>body{font:16px system-ui;background:#101815;color:#e6f3ec;padding:24px;margin:0}main{max-width:680px;margin:5vh auto}label{display:block;margin:16px 0 6px}input,textarea,button{font:inherit;padding:12px;border-radius:8px;box-sizing:border-box}input,textarea{width:100%;background:#182a21;color:white;border:1px solid #6b8878}button{border:0;background:#c5f5a8;margin:12px 12px 12px 0;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;min-height:140px;background:#182a21;padding:16px}small{color:#a8bbaf}</style></head>
<body><main><h1>Neon AI Gateway</h1><p>Stream from a configurable model. Requests stop when you cancel.</p><form id="chat"><label for="key">Example API key</label><input type="password" id="key" autocomplete="off" required><label for="prompt">Prompt</label><textarea id="prompt" maxlength="4000" required>Say hello in one short sentence.</textarea><button>Send</button><button type="button" id="cancel">Cancel</button></form><pre id="result" role="status" aria-live="polite">Ready. Paid inference must be explicitly enabled.</pre><small>The API key entered here authenticates this example, not the Neon account. Gateway tokens remain server-side. This example never buys credits.</small></main>
<script type="module">
let controller;const result=document.querySelector('#result');
document.querySelector('#cancel').onclick=()=>controller?.abort();
document.querySelector('#chat').onsubmit=async(event)=>{event.preventDefault();controller?.abort();controller=new AbortController();result.textContent='';try{const response=await fetch('/chat',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json',authorization:'Bearer '+document.querySelector('#key').value},body:JSON.stringify({prompt:document.querySelector('#prompt').value})});if(!response.ok)throw new Error('HTTP '+response.status+': '+await response.text());const reader=response.body.getReader();const decoder=new TextDecoder();let pending='';for(;;){const {value,done}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});let end;while((end=pending.indexOf('\\n'))>=0){const line=pending.slice(0,end).trim();pending=pending.slice(end+1);if(!line.startsWith('data: ')||line==='data: [DONE]')continue;const event=JSON.parse(line.slice(6));if(event.type==='text-delta')result.textContent+=event.delta;if(event.type==='error')result.textContent+='\\n'+event.errorText;}}}catch(error){result.textContent+=(error.name==='AbortError'?'\\nCancelled.':'\\n'+error.message);}};
</script></body></html>`;
