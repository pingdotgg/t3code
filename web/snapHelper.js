(async(side,tab,name)=>{
await tools.mcp__t3_code__preview_evaluate({tabId:tab,expression:"(()=>{document.activeElement?.blur();const style=document.createElement('style');style.textContent='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';document.head.append(style);return document.fonts.ready.then(()=>true)})()"});
await new Promise(r=>setTimeout(r,1200));
let prior,final,metric;
for(let attempt=0;attempt<4;attempt++){
 const a=await tools.mcp__t3_code__preview_snapshot({tabId:tab,save:true});prior=a.structuredContent?.screenshotPath;if(!prior)throw Error(JSON.stringify(a));
 await new Promise(r=>setTimeout(r,550));
 const b=await tools.mcp__t3_code__preview_snapshot({tabId:tab,save:true});final=b.structuredContent?.screenshotPath;if(!final)throw Error(JSON.stringify(b));
 const q=s=>"'"+s.replaceAll("'","'\\''")+"'";
 metric=await tools.exec_command({cmd:"compare -metric AE "+q(prior)+" "+q(final)+" null:",max_output_tokens:200});
 if(metric.exit_code===0)break;
}
if(metric.exit_code!==0)throw Error("Unsettled "+name+": "+metric.output);
const dest="/tmp/lead-33577-r2/web/raw/"+name+"-"+side+".png";
await tools.exec_command({cmd:"cp '"+final+"' '"+dest+"'",max_output_tokens:200});
const state=await tools.mcp__t3_code__preview_evaluate({tabId:tab,expression:"({text:document.body.innerText,data:window.captureData,environment:{ua:navigator.userAgent,dpr:devicePixelRatio,width:innerWidth,height:innerHeight,font:getComputedStyle(document.body).fontSize}})"});
const list=load("captures")||[];list.push({side,name,path:dest,state:state.structuredContent?.value});store("captures",list);return {side,name,path:dest};
})