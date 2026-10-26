import { mkdir,open,readFile,lstat,realpath,appendFile } from 'node:fs/promises';
import { resolve,join,dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { atomsPrompt } from '../../src/core/cycle/extract-atoms.ts';
import { API,GEMMA,CLOUD_MODELS,Budget,LIMITS,send,guardedRequest,cloudBody,gemmaBody,parseLuna,parseGemma,encodeLog,type Sender,type Prompt,type Arm,type CloudArm,type Outcome } from './adapter.ts';
export const sha=(data:Uint8Array|string)=>createHash('sha256').update(data).digest('hex');
export type Part={id:string;prompt:Prompt};
export async function loadCorpus(dir:string):Promise<Part[]> {
  const root=await realpath(dir);
  const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
  if(!Array.isArray(manifest.parts)||manifest.parts.length!==20||typeof manifest.date_grounding!=='boolean'||JSON.stringify(manifest.scanners)!=='[0,0]'||manifest.membership!==0)throw Error('CORPUS-MANIFEST');
  const checked=async(file:string,digest:string)=>{
    if(typeof file!=='string'||file.includes('/')||file.includes('..')||! /^[a-f0-9]{64}$/.test(digest))throw Error('CORPUS-PATH');
    const p=join(root,file);if((await lstat(p)).isSymbolicLink()||dirname(await realpath(p))!==root)throw Error('CORPUS-PATH');
    const data=await readFile(p);if(sha(data)!==digest)throw Error('CORPUS-HASH');return data.toString('utf8');
  };
  await checked(manifest.protocol_file,manifest.protocol_sha256);
  const seen=new Set();const parts:Part[]=[];
  for(const p of manifest.parts) {
    if(!/^p(0[1-9]|1[0-9]|20)$/.test(p.id)||seen.has(p.id)||typeof p.origin!=='string'||!/^[a-f0-9]{64}$/.test(p.source_sha256))throw Error('CORPUS-PART');seen.add(p.id);
    const text=await checked(p.file,p.sha256);parts.push({id:p.id,prompt:atomsPrompt(manifest.date_grounding,p.origin,text)});
  }
  return parts.sort((a,b)=>a.id.localeCompare(b.id));
}
export class Evidence {
  readonly protectedDir:string;
  constructor(readonly dir:string){this.protectedDir=join(dir,'protected');}
  async prepare(){
    await mkdir(this.dir,{mode:0o700});await mkdir(this.protectedDir,{mode:0o700});
    for(const p of [this.dir,this.protectedDir]){const st=await lstat(p);if(st.isSymbolicLink()||(st.mode&0o777)!==0o700||st.uid!==process.getuid!())throw Error('EVIDENCE-MODE');}
  }
  async put(name:string,data:string|Uint8Array){
    if(!/^[a-z0-9.-]+$/.test(name))throw Error('EVIDENCE-NAME');
    const fd=await open(join(this.protectedDir,name),'wx',0o600);try{await fd.writeFile(data);await fd.sync();}finally{await fd.close();}
  }
  async log(row:Record<string,unknown>){await appendFile(join(this.dir,'operations.jsonl'),encodeLog(row),{mode:0o600});}
}
export async function runPaired(parts:Part[],out:Evidence,access:()=>Promise<string>,sender:Sender=send,budget=new Budget(),cloud:CloudArm[]=['luna']) {
  if(parts.length!==20)throw Error('CORPUS-COUNT');
  if(!cloud.length||new Set(cloud).size!==cloud.length||cloud.some(a=>!(a in CLOUD_MODELS)))throw Error('CLOUD-MODELS');
  // ponytail: a fixed serial Gemma→Luna order; no orchestration or inference retries.
  await out.put('run.json',JSON.stringify({order:['gemma',...cloud],limits:LIMITS,models:{gemma:'live-8084',...Object.fromEntries(cloud.map(a=>[a,CLOUD_MODELS[a].model]))},parts:parts.map(p=>({id:p.id,system_sha256:sha(p.prompt.system),user_sha256:sha(p.prompt.messages[0].content)}))}));
  async function call(arm:CloudArm|'gemma',id:string,body:unknown):Promise<Outcome|undefined> {
    const model=arm==='gemma'?'gemma':CLOUD_MODELS[arm].model;
    const started=Date.now();let wire:Awaited<ReturnType<Sender>>|undefined;
    await out.put(`${arm}-${id}.request.json`,JSON.stringify(body??null));
    try {
      budget.take(arm);
      const token=arm!=='gemma'?await access():undefined;
      if(budget.remaining(arm)<=0)throw Error('WALL-BOUND');
      // Hard wall deadline applies to the in-flight request too.
      const bounds={connect:Math.min(LIMITS[arm].connect,budget.remaining(arm)),request:Math.min(LIMITS[arm].request,budget.remaining(arm))};
      const url=arm==='gemma'?GEMMA:id==='models'?`${API}/models`:`${API}/responses`;
      wire=await guardedRequest(url,body,async(...args)=>{wire=await sender(...args);return wire;},token?{Authorization:`Bearer ${token}`}:{},bounds);
      await out.put(`${arm}-${id}.raw`,wire.raw);
      if(id==='models') {
        const catalog=JSON.parse(wire.raw.toString());
        if(cloud.some(a=>!catalog.models?.some((m:any)=>m.slug===CLOUD_MODELS[a].model)))throw Error('MODEL-UNAVAILABLE');
        await out.log({arm,part_id:id,model,terminal_status:'SUCCESS',latency_ms:Date.now()-started,bytes:wire.raw.length});return;
      }
      const outcome=arm!=='gemma'?parseLuna(wire.raw.toString()):parseGemma(wire.raw.toString());
      await out.put(`${arm}-${id}.outcome.json`,JSON.stringify(outcome));
      await out.log({arm,part_id:id,model,terminal_status:outcome.status,error_code:outcome.code,...outcome.usage,latency_ms:Date.now()-started,bytes:wire.raw.length});
      if(outcome.status==='FAILED'||['subscription_sharing_usage_limit_exceeded','subscription_sharing_usage_unavailable'].includes(outcome.code??''))throw Error('PROVIDER-STOP');
      if(outcome.status==='UNKNOWN'||outcome.status==='FAILED-TRUNCATED')throw Error('ARM-STOP');
      return outcome;
    }catch(e:any){
      if(wire){try{await out.put(`${arm}-${id}.raw`,wire.raw);}catch(err:any){if(err.code!=='EEXIST')throw err;}}
      else if(e.raw instanceof Buffer)await out.put(`${arm}-${id}.raw`,e.raw);
      await out.log({arm,part_id:id,model,terminal_status:'STOPPED',latency_ms:Date.now()-started});
      // Only allowlisted local failures leave this boundary; raw provider errors remain protected.
      const code=typeof e.message==='string'&&/^(HTTP-(401|403|429|503|FAILED)|MODEL-UNAVAILABLE|PROVIDER-STOP|ARM-STOP|REQUEST-BOUND|WALL-BOUND|OUTPUT-BOUND|CONNECT-TIMEOUT|REQUEST-TIMEOUT|DISCONNECTED|TRANSPORT-UNKNOWN|REDIRECT|REFRESH-PENDING|REFRESH-UNKNOWN|INVALID-GRANT)$/.test(e.message)?e.message:'RUN-STOPPED';
      throw Error(code);
    }
  }
  for(const p of parts)await call('gemma',p.id,gemmaBody(p.prompt));
  // One model-list check (counted on the first cloud arm) covers every requested model; then each arm runs smoke + 20, serially.
  await call(cloud[0],'models',undefined);
  for(const arm of cloud) {
    const smoke=await call(arm,'smoke',cloudBody(arm,atomsPrompt(false,'smoke','No extractable engineering information. Return an empty atoms array.')));
    if(smoke?.status!=='SUCCESS'||!smoke.parsed?.ok||smoke.parsed.atoms.length!==0)throw Error('SMOKE-FAILED');
    for(const p of parts)await call(arm,p.id,cloudBody(arm,p.prompt));
  }
  if(budget.counts.gemma!==20||cloud.some((a,i)=>budget.counts[a]!==(i===0?22:21)))throw Error('REQUEST-TOTALS');
  await out.put('complete.json',JSON.stringify({counts:budget.counts,quality:'unscored; blind independent rating required',allowance_delta:'observational only'}));
}
