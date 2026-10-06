import * as Fly from "@/Fly";

export const Cache = Fly.Redis("WorkerQueue", { eviction: false });
export const LedgerSite = Fly.App("LedgerSite");
export const WorkerSite = Fly.App("WorkerSite");

export const services: Fly.MachineService[] = [
  {
    protocol: "tcp",
    internalPort: 3000,
    autostop: "off",
    ports: [{ port: 443, handlers: ["tls", "http"] }],
    checks: [
      {
        type: "http",
        port: 3000,
        path: "/health",
        interval: "2s",
        timeout: "1s",
      },
    ],
  },
];

export const scripts = {
  event: `
local t=redis.call('TIME')
local e=cjson.decode(ARGV[1]); e.at=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
redis.call('RPUSH','bg:events',cjson.encode(e)); return e.at`,
  enqueue: `
if redis.call('SADD','bg:produced',ARGV[1])==0 then return 0 end
return redis.call('XADD','bg:jobs','*','job',ARGV[1],'kind',ARGV[2])`,
  pause: `return redis.call('SET','bg:producer-paused','1')`,
  tick: `
if redis.call('EXISTS','bg:producer-paused')==1 then return 0 end
local t=redis.call('TIME'); local slot='tick:'..t[1]; local fresh=redis.call('SADD','bg:produced',slot)
if fresh==1 then redis.call('XADD','bg:jobs','*','job',slot,'kind','quick') end
redis.call('RPUSH','bg:events',cjson.encode({event='producer',machine=ARGV[1],version=ARGV[2],job=slot,fresh=fresh,at=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)})); return fresh`,
  claim: `
redis.pcall('XGROUP','CREATE','bg:jobs','workers','0','MKSTREAM')
local id=redis.call('SPOP','bg:reclaim')
local rows
if id then rows=redis.call('XCLAIM','bg:jobs','workers',ARGV[1],0,id)
else local read=redis.call('XREADGROUP','GROUP','workers',ARGV[1],'COUNT',1,'STREAMS','bg:jobs','>'); if read then rows=read[1][2] end end
if not rows or #rows==0 then return nil end
local row=rows[1]; local fields=row[2]; local job=fields[2]; local kind=fields[4]
local t=redis.call('TIME'); local at=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
redis.call('RPUSH','bg:events',cjson.encode({event=id and 'reclaimed' or 'claimed',machine=ARGV[1],version=ARGV[2],job=job,id=row[1],at=at}))
return cjson.encode({id=row[1],job=job,kind=kind,checkpoint=redis.call('HGET','bg:checkpoints',job) or ''})`,
  finish: `
local fresh=redis.call('HSETNX','bg:results',ARGV[2],ARGV[3])
local ack=redis.call('XACK','bg:jobs','workers',ARGV[1])
local t=redis.call('TIME'); local at=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
redis.call('RPUSH','bg:events',cjson.encode({event='acked',machine=ARGV[3],job=ARGV[2],id=ARGV[1],fresh=fresh,ack=ack,at=at})); return ack`,
  checkpoint: `
redis.call('HSET','bg:checkpoints',ARGV[2],'saved-step-1')
redis.call('SADD','bg:reclaim',ARGV[1])
local t=redis.call('TIME'); local at=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
redis.call('RPUSH','bg:events',cjson.encode({event='checkpoint',machine=ARGV[3],job=ARGV[2],id=ARGV[1],at=at})); return 1`,
  snapshot: `
local pending=redis.pcall('XPENDING','bg:jobs','workers')
return cjson.encode({events=redis.call('LRANGE','bg:events',0,-1),results=redis.call('HGETALL','bg:results'),checkpoints=redis.call('HGETALL','bg:checkpoints'),produced=redis.call('SMEMBERS','bg:produced'),entries=redis.call('XLEN','bg:jobs'),pending=pending.err and 0 or pending[1]})`,
} as const;

export interface Job {
  id: string;
  job: string;
  kind: string;
  checkpoint: string;
}
export interface LedgerEvent {
  event: string;
  machine: string;
  version?: string;
  job?: string;
  id?: string;
  at: number;
  ack?: number;
  fresh?: number;
  worker?: string;
  signal?: string;
}
export interface Snapshot {
  events: string[];
  results: string[];
  checkpoints: string[];
  produced: string[];
  pending: number;
  entries: number;
}
