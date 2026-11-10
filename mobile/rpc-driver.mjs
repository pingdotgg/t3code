import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const [side,action='seed',scenario='approval']=process.argv.slice(2);
const prefix=process.env.CAPTURE_PREFIX??'mobile';
const root=`/home/ubuntu/wt/pr-33577-mobile-${side}`;
const port=side==='before'?15733:15624;
const origin=`http://127.0.0.1:${port}`;
const authFile=`/tmp/lead-33577-r2/mobile/${side}-auth.json`;
let auth;
if(fs.existsSync(authFile)) auth=JSON.parse(fs.readFileSync(authFile));
else {
 const output=execFileSync('node',['apps/server/src/bin.ts','auth','pairing','create','--base-dir',`${root}/.t3`,'--json'],{cwd:root,encoding:'utf8'});
 const {credential}=JSON.parse(output.slice(output.indexOf('{'),output.lastIndexOf('}')+1));
 const res=await fetch(`${origin}/oauth/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:token-exchange',subject_token:credential,subject_token_type:'urn:t3:params:oauth:token-type:environment-bootstrap',requested_token_type:'urn:ietf:params:oauth:token-type:access_token',client_label:'Mobile evidence driver'})});
 auth=await res.json();if(!auth.access_token)throw Error(JSON.stringify(auth));fs.writeFileSync(authFile,JSON.stringify(auth),{mode:0o600});
}
const ticket=await (await fetch(`${origin}/api/auth/websocket-ticket/rpc`,{method:'POST',headers:{authorization:`Bearer ${auth.access_token}`}})).json();
if(!ticket.ticket) throw Error(JSON.stringify(ticket));
const ws=new WebSocket(`ws://127.0.0.1:${port}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket.ticket)}`);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
let id=0;const pending=new Map();
ws.onmessage=({data})=>{for(const m of String(data).split('\n').filter(Boolean).map(JSON.parse)){if(m._tag==='Ping'){ws.send(JSON.stringify({_tag:'Pong'}));continue}const p=pending.get(m.requestId);if(m._tag==='Chunk'){ws.send(JSON.stringify({_tag:'Ack',requestId:m.requestId}));p?.chunk?.(m.values)}if(m._tag==='Exit'){pending.delete(m.requestId);m.exit._tag==='Success'?p?.resolve(m.exit.value):p?.reject(Error(JSON.stringify(m.exit)));}}};
function rpc(tag,payload,chunk){return new Promise((resolve,reject)=>{const key=String(id++);pending.set(key,{resolve,reject,chunk});ws.send(JSON.stringify({_tag:'Request',id:key,tag,payload,headers:[]}));})}
const cmd=c=>rpc('orchestration.dispatchCommand',{...c,commandId:crypto.randomUUID()});
try {
 if(action==='seed'||action==='threads'){
 if(action==='seed') console.log(await rpc('projects.mutate',{type:'project.create',commandId:crypto.randomUUID(),projectId:'mobile-evidence',title:'Mobile evidence',workspaceRoot:`${root}/.t3/evidence-project`,createWorkspaceRootIfMissing:true,defaultModelSelection:{instanceId:'devReplay',model:scenario}}));
 for(const sc of ['question','approval']) console.log(await cmd({type:'thread.create',threadId:`${prefix}-${sc}`,projectId:'mobile-evidence',title:`${process.env.CAPTURE_TITLE??(prefix==='ios'?'iOS':'Replay')} ${sc}`,modelSelection:{instanceId:'devReplay',model:sc},runtimeMode:'approval-required',interactionMode:'default',branch:null,worktreePath:null,createdBy:'user',creationSource:'mobile'}));
 } else if(action==='start') console.log(await cmd({type:'message.dispatch',threadId:`${prefix}-${scenario}`,messageId:crypto.randomUUID(),text:'Verify the waiting timer.',attachments:[],createdBy:'user',creationSource:'mobile',dispatchMode:{type:'start_immediately'}}));
 else if(action==='detail') {rpc('orchestration.subscribeThread',{threadId:`${prefix}-${scenario}`},v=>{console.log(JSON.stringify(v));setTimeout(()=>process.exit(),50)});await new Promise(()=>{});}
 else if(action==='config') {rpc('server.subscribeConfig',{},v=>console.log(JSON.stringify(v)));await new Promise(()=>{});}
} finally {ws.close()}
