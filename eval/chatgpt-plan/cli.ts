import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { join } from 'node:path';
import { TokenStore,beginLogin,finishLogin,revoke } from './auth.ts';
import { Budget, send } from './adapter.ts';
import { Evidence,loadCorpus,runPaired,sha } from './harness.ts';
const ROOT='/srv/gbrain-eval';
async function tcp(host:string,port:number):Promise<boolean> {
 return new Promise(resolve=>{const s=createConnection({host,port});s.setTimeout(700);s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));s.once('timeout',()=>{s.destroy();resolve(false);});});
}
export async function probes(rehearsal:boolean) {
 if(!await tcp('127.0.0.1',8084))throw Error('POSITIVE-8084-FAILED');console.log('positive 8084 OK');
 if(!rehearsal) {
  const ok=await new Promise<boolean>(resolve=>{const s=tlsConnect({host:'api.openai.com',port:443,servername:'api.openai.com',rejectUnauthorized:true});s.setTimeout(10000);s.once('secureConnect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));s.once('timeout',()=>{s.destroy();resolve(false);});});
  if(!ok)throw Error('POSITIVE-TLS-FAILED');console.log('positive OpenAI TLS OK');
 }else console.log('OpenAI TLS UNEXECUTED: rehearsal forbids OpenAI network calls');
 for(const [host,port] of [['127.0.0.1',5432],['127.0.0.1',18790],['127.0.0.1',11434],['127.0.0.1',18789],['10.0.0.100',22],['::1',5432],['192.168.0.1',443],['100.64.0.1',443],['169.254.169.254',443],['fc00::1',443]] as const) {
  if(await tcp(host,port))throw Error('ISOLATION-TCP-FAILED');console.log(`denied ${host}:${port}`);
 }
 const unix=await new Promise<boolean>(resolve=>{const s=createConnection('/var/run/postgresql/.s.PGSQL.5432');s.setTimeout(500);s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));s.once('timeout',()=>{s.destroy();resolve(false);});});
 if(unix)throw Error('ISOLATION-UNIX-FAILED');console.log('denied PostgreSQL Unix socket');
 try {await readFile('/root/.gbrain/pg.env');throw Error('ISOLATION-HOME-FAILED');}catch(e:any){if(e.message==='ISOLATION-HOME-FAILED')throw e;}
 console.log('denied root credential path');
}
export function callbackListener(callback:(url:URL)=>Promise<void>) {
 return Bun.serve({hostname:'127.0.0.1',port:1455,async fetch(request){
  const url=new URL(request.url);if(url.pathname!=='/auth/callback')return new Response('Not found',{status:404});
  try {await callback(url);return new Response('Sign-in completed. Close this window.');}
  catch {return new Response('Sign-in failed; stop and inspect local status.',{status:400});}
 }});
}
async function callbackProof(path:string,profile:string) {
 if(!/^\/srv\/gbrain-eval\/out\/s552_[\w]+\.ready$/.test(path)||!['consent','evaluation'].includes(profile))throw Error('CALLBACK-PROOF-INPUT');
 let callbacks=0;const server=callbackListener(async url=>{if(url.searchParams.get('state')!=='local-rehearsal')throw Error('CALLBACK-PROOF-STATE');callbacks++;});
 try {
  if(server.hostname!=='127.0.0.1')throw Error('CALLBACK-BIND');
  await writeFile(`${path}.callback-ready`,'IPv4 loopback listener ready\n',{mode:0o600,flag:'wx'});
  const deadline=Date.now()+15000;let receipt:{completed:boolean}|undefined;
  while(Date.now()<deadline){try{receipt=JSON.parse(await readFile(`${path}.callback-result`,'utf8'));break;}catch(e:any){if(e.code!=='ENOENT')throw e;}await Bun.sleep(50);}
  if(!receipt||receipt.completed!==(profile==='consent')||callbacks!==(profile==='consent'?1:0))throw Error('CALLBACK-FORWARD-PROOF');
  console.log(`forwarded callback ${profile==='consent'?'completed':'denied'}; listener=127.0.0.1:1455; callbacks=${callbacks}`);
 }finally{await server.stop(true);}
}
async function login(store:TokenStore) {
 const port=1455,budget=new Budget();const pending=await beginLogin(store,port);
 let settle!:(error?:Error)=>void;const finished=new Promise<void>((resolve,reject)=>{settle=e=>e?reject(e):resolve();});
 const server=callbackListener(async url=>{
  try {await finishLogin(store,pending,url,undefined,budget);settle();}
  catch {settle(Error('LOGIN-FAILED'));throw Error('LOGIN-FAILED');}
 });
 const timer=setTimeout(()=>settle(Error('LOGIN-TIMEOUT')),300000);
 try {console.log('Continue with ChatGPT. Use the approved SSH loopback forward only.');console.log(pending.url);await finished;await server.stop();}finally{clearTimeout(timer);await server.stop(true);}
}
async function main() {
 const command=process.argv[2],store=new TokenStore(join(ROOT,'auth'));
 if(command==='probe')return probes(false);
 if(command==='probe-rehearsal'){await probes(true);return callbackProof(process.argv[3]!,process.argv[4]!);}
 if(command==='login')return login(store);
 if(command==='revoke') {
  // The authority-bound screenshot is supplied by Pingu, never inferred from local deletion.
  const evidence=process.argv[3];if(!evidence)throw Error('ACCOUNT-REMOVAL-EVIDENCE-REQUIRED');
  const st=await readFile(evidence);if(!st.length)throw Error('ACCOUNT-REMOVAL-EVIDENCE-REQUIRED');
  console.log(JSON.stringify(await revoke(store,true)));return;
 }
 if(command!=='run')throw Error('COMMAND');
 const grant=JSON.parse(await readFile(join(ROOT,'corpus','run-go.json'),'utf8'));
 const manifest=await readFile(join(ROOT,'corpus','manifest.json'));
 const head=(await readFile(join(ROOT,'code','BUILD-HEAD'),'utf8')).trim();
 if(grant.outbound_data_go!==true||grant.run_go!==true||grant.credits_off!==true||!(grant.weekly_cap_percent>0&&grant.weekly_cap_percent<=100)||grant.manifest_sha256!==sha(manifest)||grant.object_head!==head||!grant.cap_evidence_sha256)throw Error('RUN-GO-REQUIRED');
 const capEvidence=await readFile(join(ROOT,'corpus','allowance-evidence'));if(sha(capEvidence)!==grant.cap_evidence_sha256)throw Error('ALLOWANCE-EVIDENCE');
 const parts=await loadCorpus(join(ROOT,'corpus')),out=new Evidence(join(ROOT,'out',new Date().toISOString().replaceAll(':','-')));await out.prepare();
 await out.put('go.json',JSON.stringify(grant));const budget=new Budget();
 await runPaired(parts,out,async()=>(await store.refresh(send,budget)).access_token,undefined,budget);
}
if(import.meta.main)main().catch(()=>{console.error('S552 stopped; no retry. Inspect protected evidence locally.');process.exitCode=1;});
