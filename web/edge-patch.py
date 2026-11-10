from pathlib import Path
root=Path('/tmp/lead-33577-r2/web/scripts')
p=root/'capture-harness.tsx'
s=p.read_text().replace("import {MessagesTimeline}","import {MessagesTimeline,TurnFoldTimelineRow}")
s=s.replace("import {deriveTimelineEntriesFromVisibleTurnItems}","import {TimelineRowCtx} from './components/chat/timelineRowContext';\nimport {deriveMessagesTimelineRows} from './components/chat/MessagesTimeline.logic';\nimport {threadEnvironment} from './state/threads';\nimport {deriveTimelineEntriesFromVisibleTurnItems}")
s=s.replace("isPreparingWorktree={d.extra.isPreparingWorktree}","worktreeSetup={d.extra.backgroundRequested?{threadId:tid,phase:'running',startedAt:iso(0),endedAt:null,branch:null,baseRef:null,worktreePath:null,setupScript:{name:'Synthetic setup',command:'printf setup',terminalId:'setup-terminal'},stages:[{id:'agent',status:'done',startedAt:iso(0),endedAt:iso(1),percent:null,detail:null,tail:null},{id:'setup-script',status:'running',startedAt:iso(1),endedAt:null,percent:null,detail:null,tail:null}],error:null,sequence:1}:null} isPreparingWorktree={d.extra.isPreparingWorktree}")
a=s.index('function Gallery()');b=s.index('function App()',a)
s=s[:a]+'''function foldFor(duration,id,unknown=false,nullStart=false){
const req=request(id+'-request',0,60,'question');if(nullStart)req.startedAt=null;
const items=[prompt(id+'-prompt'),command(id+'-command'),req,answer(id+'-answer',60+duration)].map((x,i)=>({...x,ordinal:i}));
const latest={runId:rid,status:'completed',startedAt:unknown?null:iso(0),completedAt:unknown?null:iso(60+duration)};
const rows=deriveMessagesTimelineRows({timelineEntries:entries(items),latestRun:latest,isWorking:false,turnDiffSummaries:[],supportsConversationRollback:false,toolCallVisibility:'showAll'});
const row=rows.find(r=>r.kind==='turn-fold');return row;
}
function FoldOnly({row,onToggle=ignore}){return <TimelineRowCtx value={{timestampFormat:'locale',routeThreadKey:'capture-environment:capture-thread',onToggleTurnFold:onToggle}}><TurnFoldTimelineRow row={row}/></TimelineRowCtx>}
function Gallery(){const values=[[0,'zero'],[.5,'500 ms'],[5,'5 seconds'],[59.5,'59.5 seconds'],[3723,'1h 2m 3s']];return <div className="flex flex-col gap-2 p-3">{values.map(([duration,id])=><section key={id}><p className="text-xs text-muted-foreground">{id} active + known 60s wait</p><FoldOnly row={foldFor(duration,id)}/></section>)}<section><p className="text-xs text-muted-foreground">Null request start: 65s elapsed, no subtraction</p><FoldOnly row={foldFor(5,'null-start',false,true)}/></section><section><p className="text-xs text-muted-foreground">Missing run timestamps: prompt/item fallback</p><FoldOnly row={foldFor(5,'unknown',true)}/></section></div>}
let resolveDeferred;
threadEnvironment.loadEarlierHistory.run=()=>new Promise(resolve=>{resolveDeferred=resolve;});
function Deferred({phase}){const [expanded,setExpanded]=useState(false);window.captureDeferredFail=()=>resolveDeferred?.({_tag:'Success',value:{_tag:'error'}});window.captureDeferredResolve=()=>resolveDeferred?.({_tag:'Success',value:{_tag:'loaded'}});const row=foldFor(5,'deferred');if(phase==='missing-wait'){const d=data('F15','missing-wait','question');return <Timeline d={d} identity="F15-negative"/>;}return <div className="p-3"><p className="mb-3 text-xs text-muted-foreground">Harness controls server history promise; rendered fold and loading/error UI are production components.</p><FoldOnly row={{...row,expanded,deferredWorkItemIds:['loaded','reconnect'].includes(phase)?[]:['deferred-anchor']}} onToggle={()=>setExpanded(x=>!x)}/>{expanded&&['loaded','reconnect'].includes(phase)?<p className="p-3 text-sm">Harness loaded content: synthetic command completed.</p>:null}</div>}
''' + s[b:]
s=s.replace("state.fixture==='F12'&&phase==='gallery'?<Gallery/>","state.fixture==='F15'?<Deferred phase={phase}/>:state.fixture==='F12'&&phase==='gallery'?<Gallery/>")
p.write_text(s)
for side in ['before','after']:
 w=Path('/home/ubuntu/wt/pr-33577-web-'+side)
 (w/'apps/web/src/capture-harness.tsx').write_text(s)
 f=w/'apps/web/src/components/chat/MessagesTimeline.tsx'
 text=f.read_text().replace('function TurnFoldTimelineRow(', 'export function TurnFoldTimelineRow(')
 f.write_text(text)
