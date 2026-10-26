import { expect,test } from 'bun:test';
import { mkdtemp,writeFile,rm,stat,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadCorpus, Evidence, runPaired } from './harness.ts';
import { Budget } from './adapter.ts';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
async function fixture(){
 const root=await mkdtemp(join(process.env.TMPDIR!,'s552-harness-'));
 const parts=[];for(let i=1;i<=20;i++){const id=`p${String(i).padStart(2,'0')}`,body=`Synthetic input ${i}`;await writeFile(join(root,`${id}.txt`),body);parts.push({id,file:`${id}.txt`,origin:`fixture-${i}`,source_sha256:hash('synthetic source'),sha256:hash(body)});}
 const protocol='Frozen fixture thresholds, not real benchmark evidence';await writeFile(join(root,'protocol.md'),protocol);
 const manifest={parts,date_grounding:false,scanners:[0,0],membership:0,protocol_file:'protocol.md',protocol_sha256:hash(protocol)};await writeFile(join(root,'manifest.json'),JSON.stringify(manifest));
 return root;
}
test('corpus pins twenty unique files, exact hashes, scans and frozen protocol',async()=>{
 const root=await fixture();try{const parts=await loadCorpus(root);expect(parts.length).toBe(20);await writeFile(join(root,'p01.txt'),'changed');await expect(loadCorpus(root)).rejects.toThrow('CORPUS-HASH');}finally{await rm(root,{recursive:true,force:true});}
});
test('paired run uses same prompt bytes, 20 Gemma plus 22 Luna and isolated evidence',async()=>{
 const root=await fixture();try{
 const corpus=await loadCorpus(root),out=new Evidence(join(root,'out'));await out.prepare();const budget=new Budget();const requests:any[]=[];
 const sender=async(url:string,body:unknown)=>{requests.push({url,body});if(url.endsWith('/models'))return {status:200,raw:Buffer.from(JSON.stringify({models:[{slug:'gpt-6-luna',supported_reasoning_levels:[{effort:'medium'}]}]}))};
 if(url.endsWith('/responses'))return {status:200,raw:Buffer.from('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'[]'}]}]}})+'\n\n')};
 return {status:200,raw:Buffer.from(JSON.stringify({choices:[{message:{content:'[]'},finish_reason:'stop'}]}))};};
 await runPaired(corpus,out,async()=>'',sender,budget);
 expect(budget.counts).toEqual({luna:22,sol:0,gemma:20,auth:0});
 const gemma=requests.filter(x=>x.url.endsWith('/completions')),luna=requests.filter(x=>x.url.endsWith('/responses')).slice(1);
 expect(gemma.length).toBe(20);expect(luna.length).toBe(20);
 for(let i=0;i<20;i++){expect(gemma[i].body.messages[0].content).toBe(luna[i].body.instructions);expect(gemma[i].body.messages[1].content).toBe(luna[i].body.input[0].content);}
 expect((await stat(join(root,'out/protected'))).mode&0o777).toBe(0o700);
 expect((await readFile(join(root,'out/operations.jsonl'),'utf8'))).not.toContain('Synthetic input');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('a quota stop ends the whole run with no retry or fallback',async()=>{
 const root=await fixture();try{
 const corpus=await loadCorpus(root),out=new Evidence(join(root,'out'));await out.prepare();let cloud=0;
 const sender=async(url:string)=>{if(url.endsWith('/completions'))return {status:200,raw:Buffer.from(JSON.stringify({choices:[{message:{content:'[]'},finish_reason:'stop'}]}))};cloud++;return {status:429,raw:Buffer.from('{}')};};
 await expect(runPaired(corpus,out,async()=>'',sender,new Budget())).rejects.toThrow('HTTP-429');expect(cloud).toBe(1);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Luna then Sol: one model check, smoke + 20 per arm, same prompt bytes, frozen per-model effort',async()=>{
 const root=await fixture();try{
 const corpus=await loadCorpus(root),out=new Evidence(join(root,'out'));await out.prepare();const budget=new Budget();const requests:any[]=[];
 const levels=['low','medium','high'].map(effort=>({effort}));
 const sender=async(url:string,body:unknown)=>{requests.push({url,body});if(url.endsWith('/models'))return {status:200,raw:Buffer.from(JSON.stringify({models:[{slug:'gpt-6-luna',supported_reasoning_levels:levels},{slug:'gpt-6.1-sol',supported_reasoning_levels:levels}]}))};
 if(url.endsWith('/responses'))return {status:200,raw:Buffer.from('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'[]'}]}]}})+'\n\n')};
 return {status:200,raw:Buffer.from(JSON.stringify({choices:[{message:{content:'[]'},finish_reason:'stop'}]}))};};
 await runPaired(corpus,out,async()=>'',sender,budget,['luna','sol']);
 expect(budget.counts).toEqual({luna:22,sol:21,gemma:20,auth:0});
 expect(requests.filter(x=>x.url.endsWith('/models')).length).toBe(1);
 const gemma=requests.filter(x=>x.url.endsWith('/completions')),cloud=requests.filter(x=>x.url.endsWith('/responses'));
 const luna=cloud.filter(x=>x.body.model==='gpt-6-luna'),sol=cloud.filter(x=>x.body.model==='gpt-6.1-sol');
 expect(luna.length).toBe(21);expect(sol.length).toBe(21);
 expect(luna.every(x=>x.body.reasoning.effort==='medium')).toBe(true);expect(sol.every(x=>x.body.reasoning.effort==='medium')).toBe(true);
 for(let i=0;i<20;i++){for(const arm of [luna,sol]){expect(arm[i+1].body.instructions).toBe(gemma[i].body.messages[0].content);expect(arm[i+1].body.input[0].content).toBe(gemma[i].body.messages[1].content);}}
 }finally{await rm(root,{recursive:true,force:true});}
});
test('a requested model missing from the catalog stops before any cloud generation',async()=>{
 const root=await fixture();try{
 const corpus=await loadCorpus(root),out=new Evidence(join(root,'out'));await out.prepare();let generations=0;
 const sender=async(url:string)=>{if(url.endsWith('/models'))return {status:200,raw:Buffer.from(JSON.stringify({models:[{slug:'gpt-6-luna',supported_reasoning_levels:[{effort:'medium'}]}]}))};
 if(url.endsWith('/responses')){generations++;return {status:200,raw:Buffer.from('')};}
 return {status:200,raw:Buffer.from(JSON.stringify({choices:[{message:{content:'[]'},finish_reason:'stop'}]}))};};
 await expect(runPaired(corpus,out,async()=>'',sender,new Budget(),['luna','sol'])).rejects.toThrow('MODEL-UNAVAILABLE');expect(generations).toBe(0);
 await expect(runPaired(corpus,new Evidence(join(root,'out2')),async()=>'',sender,new Budget(),['luna','luna'])).rejects.toThrow('CLOUD-MODELS');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('a pinned effort the catalog does not list stops at the model check, before any cloud generation (P6 replay)',async()=>{
 const root=await fixture();try{
 const corpus=await loadCorpus(root),out=new Evidence(join(root,'out'));await out.prepare();let generations=0;
 // P6: the pinned effort was absent from Luna's levels; the old check passed and the smoke call got a 400.
 const sender=async(url:string)=>{if(url.endsWith('/models'))return {status:200,raw:Buffer.from(JSON.stringify({models:[{slug:'gpt-6-luna',supported_reasoning_levels:[{effort:'low'}]},{slug:'gpt-6.1-sol',supported_reasoning_levels:[{effort:'medium'}]}]}))};
 if(url.endsWith('/responses')){generations++;return {status:400,raw:Buffer.from('')};}
 return {status:200,raw:Buffer.from(JSON.stringify({choices:[{message:{content:'[]'},finish_reason:'stop'}]}))};};
 await expect(runPaired(corpus,out,async()=>'',sender,new Budget(),['luna','sol'])).rejects.toThrow('EFFORT-UNSUPPORTED');expect(generations).toBe(0);
 }finally{await rm(root,{recursive:true,force:true});}
});
