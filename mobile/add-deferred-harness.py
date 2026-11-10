from pathlib import Path
for side in ['before','after']:
 root=Path('/home/ubuntu/wt/pr-33577-mobile-'+side)
 p=root/'apps/mobile/src/features/threads/ThreadFeed.tsx';s=p.read_text();a=s.index('export function RunFoldButton(');b=s.index('\nfunction renderFeedEntry',a);frag=s[a:b];frag=frag.replace('  iconColor,\n','  iconColor,\n  captureLoader,\n',1).replace('  iconColor: ColorValue;','  iconColor: ColorValue;\n  captureLoader?: () => Promise<boolean>;',1).replace('    if (!anchorsKey) return;','    if (!anchorsKey) return;\n    if (captureLoader) { void captureLoader().then(ok => setFailed(!ok)); return; }',1);s=s[:a]+frag+s[b:];p.write_text(s)
 p=root/'apps/mobile/src/CaptureHarness.tsx';s=p.read_text().replace("{useState}","{useState,useRef}")
 s=s.replace("const {width,height,fontScale,scale}=useWindowDimensions();","const {width,height,fontScale,scale}=useWindowDimensions();\n const loader=useRef<((ok:boolean)=>void)|null>(null);const [loaded,setLoaded]=useState(false);\n const load=()=>new Promise<boolean>(resolve=>{loader.current=resolve});")
 s=s.replace("const folds=rows.filter((e:any)=>e.type==='run-fold');","const folds=rows.filter((e:any)=>e.type==='run-fold').map((entry:any)=>page===9?{...entry,deferredWorkItemIds:loaded?[]:['synthetic-anchor']}:entry);")
 s=s.replace("environmentId={'' as any}","environmentId={'capture-environment' as any}").replace("iconColor={colors.muted}/>","iconColor={colors.muted} captureLoader={page===9?load:undefined}/>")
 s=s.replace("setExpanded(new Set())})}","setExpanded(new Set());setLoaded(false)})}")
 s=s.replace("{page===9?<Text style={text}>Deferred callback/loading/retry remains unverified in this harness.</Text>:null}","{page===9?<><Text style={text}>Harness callback gate: expand, fail, retry, complete.</Text>{button('Fail deferred',()=>loader.current?.(false))}{button('Complete deferred',()=>{setLoaded(true);loader.current?.(true)})}{button('Missing wait control',()=>{setKind(kind==='message'?'question':'message')})}</>:null}")
 # Missing wait control feeds no wait row on the negative-control stage.
 s=s.replace("let runStart:string|null=iso(0)","if(page===9&&kind==='message')source=source.filter(item=>item.id!=='wait');\n let runStart:string|null=iso(0)")
 p.write_text(s)
