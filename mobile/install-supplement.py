from pathlib import Path
for side in ['before','after']:
 p=Path('/home/ubuntu/wt/pr-33577-mobile-'+side+'/apps/mobile/src/CaptureHarness.tsx');s=p.read_text();Path('/tmp/lead-33577-r2/mobile/scripts/CaptureHarness.'+side+'.tsx').write_text(s)
 s=s.replace('CAPTURE_ENABLED=false','CAPTURE_ENABLED=true').replace("[kind,setKind]=useState('question')","[kind,setKind]=useState('approval')")
 s=s.replace('const {width,height,fontScale,scale}=useWindowDimensions();','const {width,height,fontScale,scale}=useWindowDimensions();\n const [frame,setFrame]=useState(0);useEffect(()=>{const t=setInterval(()=>setFrame(n=>n+1),500);return()=>clearInterval(t)},[]);')
 s=s.replace('Fixture clock t={now}s · {kind}','Fixture clock t={now}s · {kind} · capture frame {frame}')
 s=s.replace('key={`${page}:${step}:${kind}`}','key={`${page}:${kind}`}')
 s=s.replace("'F15 deferred history'];","'F15 deferred history','F12 fallback render props'];")
 s=s.replace('if(page===7){source=[];}','if(page===7){source=[];}\n if(page===10){source[2]={...source[2],startedAt:null};}')
 s=s.replace('let status:any=', 'let status:any=')
 s=s.replace('const latest=page===1', "if(page===10)status={kind:'working',startedAt:null};\n const latest=page===1")
 s=s.replace("{page===9?<><Text", "{page===10?<><Text style={text}>Null request start: no deduction. Unknown duration below uses a render prop; invalid wire data is not seeded.</Text>{folds.map((e:any)=>fold({...e,duration:null},'unknown'))}</>:null}\n {page===9?<><Text")
 p.write_text(s);Path('/tmp/lead-33577-r2/mobile/scripts/CaptureSupplement.'+side+'.tsx').write_text(s)
