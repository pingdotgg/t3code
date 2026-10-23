from pathlib import Path
import hashlib,json,sys
root=Path(__file__).resolve().parents[3]; out=root/'apps/web/src/evidence-14743'
report_dir=Path(sys.argv[1]); report_dir.mkdir(parents=True,exist_ok=True)
hook=(root/'apps/web/src/components/settings/useScopedSettings.ts').read_text()
# Only imports at runtime boundaries change. Actual useUpdateScopedSettings and runner bodies are copied verbatim.
hook=hook.replace('from "../../state/session"','from "./boundary"').replace('from "../../hooks/useSettings"','from "./boundary"').replace('from "../../state/server"','from "./boundary"').replace('from "../../state/use-atom-command"','from "./boundary"').replace('from "../ui/toast"','from "../components/ui/toast"').replace('from "./SettingsScopeContext"','from "./context"').replace('from "./scopedSettings"','from "../components/settings/scopedSettings"')
(out/'scoped-hook.ts').write_text(hook)
ctx=(root/'apps/web/src/components/settings/SettingsScopeContext.tsx').read_text()
a=ctx.index('const SettingsScopeContext ='); b=ctx.index('export function SettingsScopeProvider')
c=ctx[a:b].replace('const SettingsScopeContext =','export const SettingsScopeContext =')
(out/'context.tsx').write_text('import {createContext,useContext} from "react";\n'+c+'\n'+ctx[ctx.index('export function useOptionalSettingsScope'):])
(out/'boundary.ts').write_text('''export const serverEnvironment={updateSettings:{}};
export const readEnvironmentScope=()=>true;
export const useEnvironmentsWithScope=()=>new Set(['proof-a','proof-b']);
export const useMergedSettings=(x,s)=>s?s(x):x;
export const useMigrateModelPreferences=()=>{};
export const persistClientSettingsPatch=()=>{throw Error('Unexpected client write')};
export const useAtomCommand=()=>request=>window.runnerCommand(request);
''')
control=(out/'after.tsx').read_text(); a=control.index('function RetentionControl'); b=control.index('const logs=[]')
control=control[a:b]
(out/'runner.tsx').write_text('''import React,{useState,useRef,useLayoutEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {createRouter,createRootRoute,RouterProvider} from '@tanstack/react-router';
import {DEFAULT_SERVER_SETTINGS} from '@t3tools/contracts';
import * as Cause from 'effect/Cause';
import {Switch} from '../components/ui/switch';
import {NumberField,NumberFieldDecrement,NumberFieldGroup,NumberFieldIncrement,NumberFieldInput} from '../components/ui/number-field';
import {ToastProvider} from '../components/ui/toast';
import {SettingsScopeContext} from './context';
import {useUpdateScopedSettings} from './scoped-hook';
import '../index.css';
'''+control+'''
const journal=[];const pending=[];let api={};
window.proof={journal,pending,reset:()=>api.reset(),unavailable:()=>api.unavailable(),resolve:(id,ok)=>{const p=pending.find(p=>p.id===id);if(!p||p.settled)throw Error('Unknown or settled request '+id);p.settled=true;journal.push({ack:id,ok,at:new Date().toISOString()});let saved;if(ok)saved=api.publish(p.request);p.resolve(ok?{_tag:'Success',value:saved}:{_tag:'Failure',cause:Cause.fail(new Error('Controlled server command failure'))})}};
function Control({value}){const update=useUpdateScopedSettings();return <section className="flex items-center justify-between gap-2 border p-4"><span>Delete inactive worktrees</span><RetentionControl label="Delete inactive worktrees" value={value} onChange={v=>{const result=update({storageCleanup:{worktreeAfterDays:v}});return result?.then(ok=>{journal.push({outcome:ok,at:new Date().toISOString()});api.refresh();return ok})}}/></section>}
function App(){const [values,setValues]=useState([null,null]);const [two,setTwo]=useState(false);const [connected,setConnected]=useState(true);const [key,setKey]=useState(0);const [,refresh]=useState(0);
const settings=i=>({...DEFAULT_SERVER_SETTINGS,storageCleanup:{...DEFAULT_SERVER_SETTINGS.storageCleanup,worktreeAfterDays:values[i],worktreeSettledAfterDays:null,browserArtifactsAfterDays:null,logsAfterDays:null,worktreeOnMerge:false,worktreeOnDelete:false,worktreeUnchanged:false},worktreeCleanup:null});
api={refresh:()=>refresh(x=>x+1),reset:()=>{pending.length=0;journal.length=0;setValues([null,null]);setConnected(true);setKey(k=>k+1)},unavailable:()=>setConnected(false),publish:request=>{const i=request.environmentId==='proof-a'?0:1;const v=request.input.patch.storageCleanup.worktreeAfterDays;setValues(xs=>xs.map((x,j)=>i===j?v:x));return {...settings(i),storageCleanup:{...settings(i).storageCleanup,worktreeAfterDays:v}}}};
window.runnerCommand=request=>new Promise(resolve=>{const id=pending.length+1;pending.push({id,request,resolve});journal.push({request:id,...request,at:new Date().toISOString()});refresh(x=>x+1)});
const environments=(two?[0,1]:[0]).map(i=>({environmentId:i===0?'proof-a':'proof-b',label:i===0?'Displayed A':'Target B',connection:{phase:connected?'connected':'disconnected'},serverConfig:{settings:settings(i)}}));
const context={scope:{kind:'all',environmentIds:environments.map(e=>e.environmentId)},environments};
return <ToastProvider timeout={60000}><main className="p-8 space-y-6"><h1>Actual scoped settings runner — controlled command boundary</h1><p>Verbatim useUpdateScopedSettings / useRunScopedPlan, actual context and toast provider. No transport or disk persistence claim.</p><label>Two targets <input type="checkbox" checked={two} onChange={e=>setTwo(e.target.checked)}/></label><SettingsScopeContext value={context}><Control key={key} value={values[0]}/></SettingsScopeContext><button onClick={()=>api.reset()}>Reset seed</button><button onClick={()=>api.unavailable()}>Make plan unavailable</button><button onClick={()=>refresh(x=>x+1)}>Refresh log</button><button id="outside">Outside focus target</button><pre className="max-h-60 overflow-auto text-xs">{JSON.stringify({values,connected,journal},null,2)}</pre></main></ToastProvider>}
const route=createRootRoute({component:App});const router=createRouter({routeTree:route});createRoot(document.getElementById('root')).render(<RouterProvider router={router}/>);
''')
(root/'apps/web/evidence-14743-runner.html').write_text('<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/src/evidence-14743/runner.tsx"></script></body></html>')
(report_dir/'source-equivalence.json').write_text(json.dumps({'hookOriginalSha256':hashlib.sha256((root/'apps/web/src/components/settings/useScopedSettings.ts').read_bytes()).hexdigest(),'hookBodyVerbatim':hook[hook.index('function useRunScopedPlan'):]==(root/'apps/web/src/components/settings/useScopedSettings.ts').read_text()[(root/'apps/web/src/components/settings/useScopedSettings.ts').read_text().index('function useRunScopedPlan'):],'contextDeclarationVerbatimExceptExport':True,'commandBoundary':'useAtomCommand controlled; readEnvironmentScope true; actual planner, persistence aggregation, hook, context and toast provider'},indent=2))
