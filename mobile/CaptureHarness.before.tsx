import * as SplashScreen from 'expo-splash-screen';
import React, {useState,useRef,useEffect} from 'react';
import {View,Text,Pressable,ScrollView,StatusBar,Platform,useWindowDimensions} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {SafeAreaProvider,SafeAreaView} from 'react-native-safe-area-context';
import {DateTime} from 'effect';
import {RunFoldButton} from './features/threads/ThreadFeed';
import {FloatingWorkingControl} from './features/threads/floating-working-control';
import {buildThreadFeed,deriveThreadFeedPresentation} from './lib/threadActivity';
import {deriveThreadWorkLogSizing} from './lib/layout';
import {useAppearancePreferences} from './features/settings/appearance/AppearancePreferencesProvider';
const resolveCaptureTimer=(input:{runStartedAt:string|null;runlessStartedAt:string|null;items:unknown[]})=>input.runStartedAt??input.runlessStartedAt;
export const CAPTURE_ENABLED=false;
const Stack=createNativeStackNavigator();
const origin=Date.parse('2026-06-20T00:00:00.000Z');
const iso=(s:number)=>new Date(origin+s*1000).toISOString();
const dt=(s:number)=>DateTime.makeUnsafe(iso(s));
const threadId='capture-thread',runId='capture-run';
function base(id:string,s:number,n:number,r:string|null=runId){return {id,threadId,runId:r,nodeId:null,providerThreadId:null,providerTurnId:null,nativeItemRef:null,parentItemId:null,ordinal:n,status:'completed',title:null,startedAt:dt(s),completedAt:dt(s),updatedAt:dt(s)}}
function items(end=65,wait=60,kind='question',r:string|null=runId){const waitEnd=Math.min(end,2+wait);return [
 {...base('user',0,0,r),type:'user_message',messageId:'user-message',createdBy:'user',creationSource:'mobile',inputIntent:'turn_start',text:'Run checks',attachments:[]},
 {...base('cmd',1,1,r),type:'command_execution',input:'vp test run focused',output:'ok',exitCode:0},
 {...base('wait',waitEnd,2,r),startedAt:dt(Math.max(0,waitEnd-wait)),type:kind==='approval'?'approval_request':'user_input_request',requestId:'request-1',questions:[],questionAnswer:{requestId:'request-1',questionTextById:{color:'Which color?'},answers:{color:'Blue'},attachmentsByQuestionId:{}}},
 {...base('answer',end,3,r),type:'assistant_message',messageId:'assistant-message',text:'Done',streaming:false}
 ]}
const projected=(it:any[])=>it.map((item,position)=>({item,position,visibility:'local',sourceThreadId:threadId,sourceItemId:item.id}));
const pages=['F3/F4 latest','F5 history','F5 runless history','F7 runless ownership','F8 wake continuity','F9 message question','F12 duration gallery','F12 minute boundary','F13 priorities','F15 deferred history'];
const noop=()=>{};
function Screen(){
 useEffect(()=>{SplashScreen.hide()},[]);
 const {themeAppearance}=useAppearancePreferences();const dark=themeAppearance==='dark';
 const colors={bg:dark?'#0a0a0a':'#fff',fg:dark?'#eee':'#171717',muted:dark?'#aaa':'#555',line:dark?'#333':'#ddd'};
 const [page,setPage]=useState(0),[step,setStep]=useState(0),[expanded,setExpanded]=useState(new Set<string>()),[kind,setKind]=useState('question');
 const {width,height,fontScale,scale}=useWindowDimensions();
 const loader=useRef<((ok:boolean)=>void)|null>(null);const [loaded,setLoaded]=useState(false);
 const load=()=>new Promise<boolean>(resolve=>{loader.current=resolve});
 const text={color:colors.fg,fontSize:15};
 let now=[1,2,62,64,65][Math.min(step,4)]!;
 if(page===7)now=[59,60,61][step%3]!;
 if(page===4)now=84;
 if(page===5)now=[2,62,64,65][step%4]!;
 (globalThis as any).__captureNow=origin+now*1000;
 queueMicrotask(()=> (globalThis as any).__captureListeners?.forEach((fn:()=>void)=>fn()));
 const pending=page===0&&(step===1||step===2);
 let source=items(65,60,kind,page===2||page===3?null:runId);
 if(page===0&&step===0)source=source.filter(item=>item.id!=='wait');
 if(page===0&&(step===1||step===2))source[2]={...source[2],completedAt:null};
 if(page===9&&kind==='message')source=source.filter(item=>item.id!=='wait');
 let runStart:string|null=iso(0),runlessStart:string|null=null;
 if(page===3){runStart=null;runlessStart=iso(0);source=items(65,60,kind,null);source.push({...source[2],id:'foreign',runId:'foreign-run',startedAt:dt(0),completedAt:dt(64)});source.push({...source[2],id:'earlier',startedAt:dt(-90),completedAt:dt(-30)});now=64;(globalThis as any).__captureNow=origin+64000;}
 if(page===4){source=items();source[2]={...source[2],runId:'predecessor'};source.push({...source[2],id:'too-early',startedAt:dt(-5),completedAt:dt(0)});source.push({...source[2],id:'foreign-open',runId:'foreign-run',startedAt:dt(81),completedAt:null});}
 if(page===5){source[2]={...source[2],type:'user_input_request',responseMode:'message',completedAt:null};}
 if(page===7){source=[];}
 const timerInput={runStartedAt:runStart,runlessStartedAt:runlessStart,items:source};
 const timerStart=resolveCaptureTimer(timerInput);
 const complete=page===0?step>=4:![3,4,7,8].includes(page)&&(page!==5||step%4===3);
 let status:any=(page===0&&!complete&&!pending)||([3,4,7].includes(page)||(page===5&&step%4!==3))?{kind:'working',startedAt:timerStart}:null;
 if(page===4&&step%2===1)status=null;
 if(page===8)status=[{kind:'preparing',label:'Setting up worktree…'},{kind:'syncing',label:'Syncing thread…'},{kind:'compacting'},{kind:'child-input',label:'Question from child',accessibilityLabel:'Open question',onPress:noop},{kind:'connection',tone:'unavailable',label:'Environment disconnected',onPress:noop},{kind:'working',startedAt:iso(0)}][step%6];
 const latest=page===1||page===2?null:{runId,status:'completed',startedAt:iso(0),completedAt:iso(65)};
 const rows=deriveThreadFeedPresentation(buildThreadFeed(projected(source) as any),latest as any,expanded as any);
 const folds=rows.filter((e:any)=>e.type==='run-fold').map((entry:any)=>page===9?{...entry,deferredWorkItemIds:loaded?[]:['synthetic-anchor']}:entry);
 const toggle=(id:string)=>setExpanded(old=>{const next=new Set(old);next.has(id)?next.delete(id):next.add(id);return next});
 function fold(entry:any,key=entry.id){return <View key={key} style={{borderTopWidth:1,borderColor:colors.line,paddingVertical:7}}><RunFoldButton entry={entry} environmentId={'capture-environment' as any} threadId={threadId as any} onToggle={toggle as any} rowSizing={deriveThreadWorkLogSizing({baseFontSize:15,fontScale})} iconColor={colors.muted} captureLoader={page===9?load:undefined}/>{entry.expanded?<Text style={text}>Command: vp test run focused · ok</Text>:null}</View>}
 const button=(label:string,onPress:()=>void)=><Pressable key={label} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={{padding:12,borderWidth:1,borderColor:colors.line,borderRadius:8}}><Text style={text}>{label}</Text></Pressable>;
 return <SafeAreaView style={{flex:1,backgroundColor:colors.bg}}><StatusBar hidden/><View style={{padding:16,gap:8}}><Text style={{...text,fontWeight:'700'}}>Harness: synthetic turn items</Text><Text style={text}>{pages[page]}</Text><Text style={{color:colors.muted,fontSize:12}}>{Platform.OS} · {width}×{height} · DPR {scale} · font {fontScale}</Text><Text style={text}>Fixture clock t={now}s · {kind}</Text><View style={{flexDirection:'row',gap:8}}>{button('Next chapter',()=>{setPage((page+1)%pages.length);setStep(0);setExpanded(new Set());setLoaded(false)})}{button('Next stage',()=>setStep(step+1))}{button('Request type',()=>setKind(kind==='question'?'approval':'question'))}</View></View>
 <ScrollView style={{flex:1}} contentContainerStyle={{padding:16,paddingBottom:120,gap:12}}>
 {page===6?<>{[0,.5,5,59.5,3723].map((work,i)=>{const end=work+60;const list=items(end,60,kind);const row=deriveThreadFeedPresentation(buildThreadFeed(projected(list) as any),{runId,status:'completed',startedAt:iso(0),completedAt:iso(end)} as any,new Set()).find((e:any)=>e.type==='run-fold');return <View key={i}><Text style={text}>Worked {work}s + wait 60s</Text>{row?fold(row,String(i)):<Text style={text}>No fold</Text>}</View>})}</>:<>
 <Text style={text}>Run checks</Text>
 {pending?<Text style={text}>Pending {kind}: timer hidden</Text>:null}
 {complete&&page!==8&&page!==7?folds.map((e:any)=>fold(e)):null}
 {complete&&page!==8&&page!==7?<Text style={text}>Done</Text>:null}
 {page===3?<Text style={text}>Own runless wait 2–62; earlier wait −90–−30; foreign run wait 0–64.</Text>:null}
 {page===4?<Text style={text}>Inherited start 0; predecessor wait 2–62. Earlier and foreign open requests ignored for waiting. Stage toggles owned wake request.</Text>:null}
 {page===5?<Text style={text}>Open responseMode=message question; work continues.</Text>:null}
 {page===8?<Text style={text}>Injected status props exercise the real floating control. Status selection is outside this harness.</Text>:null}
 {page===9?<><Text style={text}>Harness callback gate: expand, fail, retry, complete.</Text>{button('Fail deferred',()=>loader.current?.(false))}{button('Complete deferred',()=>{setLoaded(true);loader.current?.(true)})}{button('Missing wait control',()=>{setKind(kind==='message'?'question':'message')})}</>:null}
 </>}
 </ScrollView>
 <View style={{height:80,margin:16,borderWidth:1,borderColor:colors.line,borderRadius:20,justifyContent:'center',padding:16}}><Text style={{color:colors.muted}}>Ask anything · synthetic fixture</Text><FloatingWorkingControl key={`${page}:${step}:${kind}`} colorScheme={dark?'dark':'light'} status={status} devicePreview={null} browserPreview={null} showScrollToEnd={false} onScrollToEnd={noop} agents={null} onOpenAgents={noop} queuedCount={0} onOpenQueue={noop}/></View>
 </SafeAreaView>
}
export default function CaptureHarness(){return <SafeAreaProvider><NavigationContainer><Stack.Navigator screenOptions={{headerShown:false,animation:'none'}}><Stack.Screen name="Capture" component={Screen}/></Stack.Navigator></NavigationContainer></SafeAreaProvider>}
