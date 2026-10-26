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
 const sender=async(url:string,body:unknown)=>{requests.push({url,body});if(url.endsWith('/models'))return {status:200,raw:Buffer.from(JSON.stringify({models:[{slug:'gpt-6-luna'}]}))};
 if(url.endsWith('/responses'))return {status:200,raw:Buffer.from('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'[]'}]}]}})+'\n\n')};
 return {status:200,raw:Buffer.from(JSON.stringify({choices:[{message:{content:'[]'},finish_reason:'stop'}]}))};};
 await runPaired(corpus,out,async()=>'',sender,budget);
 expect(budget.counts).toEqual({luna:22,gemma:20,auth:0});
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
