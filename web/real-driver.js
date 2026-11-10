export async function setup() {
const [{appAtomRegistry},{threadEnvironment},{serverEnvironment},settings]=await Promise.all([import('/src/rpc/atomRegistry.ts'),import('/src/state/threads.ts'),import('/src/state/server.ts'),import('/src/hooks/useSettings.ts')]);
const environmentId=location.pathname.split('/')[1];
const atom=threadEnvironment.snapshotAtom(environmentId);
const snapshot=await new Promise(resolve=>{let stop;stop=appAtomRegistry.subscribe(atom,value=>{if(value){resolve(value);queueMicrotask(()=>stop?.());}},{immediate:true});});
const run=(command,input)=>command.run(appAtomRegistry,{environmentId,input});
window.capture={environmentId,run,threadEnvironment,serverEnvironment,settings,projectId:snapshot.projects[0].id};
return {environmentId,projectId:snapshot.projects[0].id};
}
export async function create(model,title,instanceId='devReplay') {
await setup(); const c=window.capture; const threadId=crypto.randomUUID();
const result=await c.run(c.threadEnvironment.create,{threadId,projectId:c.projectId,title,modelSelection:{instanceId,model},runtimeMode:'approval-required',interactionMode:'default',branch:null,worktreePath:null});
if(result._tag!=='Success')throw new Error(JSON.stringify(result));
return '/'+c.environmentId+'/'+encodeURIComponent(threadId);
}
export async function send(text) {const c=window.capture;const threadId=decodeURIComponent(location.pathname.split('/')[2]);return c.run(c.threadEnvironment.startTurn,{threadId,message:{messageId:crypto.randomUUID(),role:'user',text,attachments:[]},runtimeMode:'approval-required',interactionMode:'default'});}
export async function visibility(value) {await setup();await window.capture.settings.updateClientSettings({toolCallVisibility:value});return value;}
export async function rename(title) {await setup();return window.capture.run(window.capture.threadEnvironment.updateMetadata,{threadId:decodeURIComponent(location.pathname.split('/')[2]),title});}
