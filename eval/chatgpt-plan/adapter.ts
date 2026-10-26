import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createParser } from 'eventsource-parser';
import { parseAtomsOutcome, type AtomsParseOutcome } from '../../src/core/cycle/extract-atoms-parse.ts';

export const LUNA = 'gpt-6-luna';
export const API = 'https://api.openai.com/v1';
export const TOKEN = 'https://auth.openai.com/api/accounts/oauth/token';
export const DISCOVERY = 'https://auth.openai.com/.well-known/openid-configuration';
export const GEMMA = 'http://127.0.0.1:8084/v1/chat/completions';
export const LIMITS = {
  luna: { requests:22, connect:10_000, request:120_000, wall:2_700_000 },
  gemma: { requests:20, connect:5_000, request:300_000, wall:3_600_000 },
  // Auth traffic is separate: discovery/JWKS/code exchange, refresh and revoke checks.
  auth: { requests:12, connect:10_000, request:30_000, wall:900_000 },
} as const;
export const MAX_BYTES = 256 * 1024;
export type Arm = keyof typeof LIMITS;
export type Prompt = {system:string; messages:Array<{role:'user';content:string}>};
export type Wire = {status:number; raw:Buffer};
export type Sender = (url:string, body:unknown, headers?:Record<string,string>, bounds?:{connect:number;request:number}) => Promise<Wire>;
export type Outcome = {status:string; parsed?:AtomsParseOutcome; code?:string; usage?:{input_tokens?:number;output_tokens?:number}};
export class Budget {
  counts = {luna:0,gemma:0,auth:0};
  private starts:Partial<Record<Arm,number>> = {};
  constructor(private clock:()=>number=Date.now) {}
  remaining(arm:Arm) { return LIMITS[arm].wall - (this.clock() - (this.starts[arm] ?? this.clock())); }
  take(arm:Arm) {
    this.starts[arm] ??= this.clock();
    if(this.remaining(arm)<=0) throw Error('WALL-BOUND');
    if(this.counts[arm]>=LIMITS[arm].requests) throw Error('REQUEST-BOUND');
    this.counts[arm]++;
  }
}
export function lunaBody(p:Prompt) { return {model:LUNA,instructions:p.system,input:p.messages,stream:true,store:false,reasoning:{effort:'minimal'}}; }
export function gemmaBody(p:Prompt) { return {model:'gemma',messages:[{role:'system',content:p.system},...p.messages],max_tokens:8192,chat_template_kwargs:{enable_thinking:false}}; }
function validateBody(body:unknown) {
  const b=body as ReturnType<typeof lunaBody>;
  if(!b || Object.keys(b).sort().join(',')!=='input,instructions,model,reasoning,store,stream' || b.model!==LUNA || b.stream!==true || b.store!==false || typeof b.instructions!=='string' || JSON.stringify(b.reasoning)!=='{"effort":"minimal"}' || !Array.isArray(b.input) || b.input.length!==1 || b.input.some(i=>Object.keys(i).sort().join(',')!=='content,role' || i.role!=='user' || typeof i.content!=='string')) throw Error('REQUEST-SHAPE');
}
export function fixedEndpoint(url:string) {
  if(![`${API}/models`,`${API}/responses`,TOKEN,DISCOVERY,'https://auth.openai.com/.well-known/jwks.json',GEMMA].includes(url)) throw Error('ENDPOINT');
}
/** Native transport has no redirects, proxy environment, SDK retries, or error-body logging. */
export const send:Sender = (url, body, headers={}, bounds=LIMITS.luna) => new Promise((resolve,reject)=>{
  fixedEndpoint(url);
  const data=body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body);
  let finished=false, size=0; const chunks:Buffer[]=[];
  const fail=(code:string)=>{if(finished)return;finished=true;clearTimeout(connect);clearTimeout(deadline);req.destroy();reject(Object.assign(Error(code),{raw:Buffer.concat(chunks)}));};
  const req=(url.startsWith('https:')?httpsRequest:httpRequest)(url,{method:data===undefined?'GET':'POST',headers:{...(data===undefined?{}:{'Content-Type':typeof body==='string'?'application/x-www-form-urlencoded':'application/json'}),...headers}},res=>{
    clearTimeout(connect);
    if((res.statusCode??0)>=300 && (res.statusCode??0)<400) {res.destroy();fail('REDIRECT');return;}
    res.on('data',(c:Buffer)=>{size+=c.length;if(size>MAX_BYTES){fail('OUTPUT-BOUND');return;}chunks.push(c);});
    res.on('aborted',()=>fail('DISCONNECTED'));res.on('error',()=>fail('DISCONNECTED'));
    res.on('end',()=>{if(finished)return;finished=true;clearTimeout(deadline);resolve({status:res.statusCode??0,raw:Buffer.concat(chunks)});});
  });
  const connect=setTimeout(()=>fail('CONNECT-TIMEOUT'),bounds.connect);
  const deadline=setTimeout(()=>fail('REQUEST-TIMEOUT'),bounds.request);
  req.on('socket',socket=>{const ready=url.startsWith('https:')?'secureConnect':'connect';socket.once(ready,()=>clearTimeout(connect));});
  req.on('error',()=>fail('TRANSPORT-UNKNOWN'));
  req.end(data);
});
export async function guardedRequest(url:string, body:unknown, sender:Sender=send, headers:Record<string,string>={}, bounds:{connect:number;request:number}=LIMITS.luna):Promise<Wire> {
  fixedEndpoint(url);
  if(url===`${API}/responses`) validateBody(body);
  const result=await sender(url,body,headers,bounds);
  if(result.raw.length>MAX_BYTES) throw Error('OUTPUT-BOUND');
  if(result.status>=300 && result.status<400) throw Error('REDIRECT');
  if(result.status!==200) throw Error([401,403,429,503].includes(result.status)?`HTTP-${result.status}`:'HTTP-FAILED');
  return result;
}
const safeCodes=new Set(['subscription_sharing_usage_limit_exceeded','subscription_sharing_usage_unavailable','invalid_grant','unsupported_parameter','invalid_request_error']);
export function safeCode(code:unknown) {return typeof code==='string'&&safeCodes.has(code)?code:'UNKNOWN';}
export function parseLuna(raw:string):Outcome {
  let terminal:Outcome|undefined, malformed=false, sawTerminal=false;
  const parser=createParser({onError:()=>{malformed=true;},onEvent:e=>{
    if(e.data==='[DONE]')return;
    try {
      const data=JSON.parse(e.data);
      if(!['response.completed','response.failed','response.incomplete','error'].includes(data.type))return;
      if(sawTerminal){malformed=true;return;}sawTerminal=true;
      if(data.type==='response.incomplete') {terminal={status:'FAILED-TRUNCATED',parsed:parseAtomsOutcome('', 'length')};return;}
      if(data.type!=='response.completed') {terminal={status:'FAILED',code:safeCode(data.response?.error?.code??data.code)};return;}
      const response=data.response;
      if(response?.status!=='completed' || !Array.isArray(response.output)){malformed=true;return;}
      const contents=response.output.filter((o:any)=>o.type==='message').flatMap((o:any)=>o.content??[]);
      if(contents.some((c:any)=>c.type==='refusal')) {terminal={status:'FAILED',parsed:parseAtomsOutcome('','refusal')};return;}
      const text=contents.filter((c:any)=>c.type==='output_text'&&typeof c.text==='string').map((c:any)=>c.text).join('');
      const parsed=parseAtomsOutcome(text,'stop');
      terminal={status:parsed.ok?'SUCCESS':'FAILED-SCHEMA',parsed,usage:{input_tokens:response.usage?.input_tokens,output_tokens:response.usage?.output_tokens}};
    } catch {malformed=true;}
  }});
  try {parser.feed(raw);parser.reset({consume:true});} catch {malformed=true;}
  return malformed?{status:'UNKNOWN'}:terminal??{status:'UNKNOWN'};
}
export function parseGemma(raw:string):Outcome {
  try {
    const data=JSON.parse(raw), choice=data.choices?.[0];
    if(!choice || typeof choice.message?.content!=='string' || typeof choice.finish_reason!=='string')return {status:'UNKNOWN'};
    const parsed=parseAtomsOutcome(choice.message.content,choice.finish_reason);
    return {status:choice.finish_reason==='length'?'FAILED-TRUNCATED':parsed.ok?'SUCCESS':'FAILED-SCHEMA',parsed,usage:{input_tokens:data.usage?.prompt_tokens,output_tokens:data.usage?.completion_tokens}};
  } catch {return {status:'UNKNOWN'};}
}
const statuses=new Set(['SUCCESS','FAILED','FAILED-SCHEMA','FAILED-TRUNCATED','UNKNOWN','STOPPED']);
export function encodeLog(row:Record<string,unknown>) {
  const safe:Record<string,unknown>={ts:new Date().toISOString()};
  for(const key of ['latency_ms','bytes','input_tokens','output_tokens']) if(typeof row[key]==='number'&&Number.isFinite(row[key]))safe[key]=row[key];
  if(['luna','gemma','auth'].includes(row.arm as string))safe.arm=row.arm;
  if(typeof row.part_id==='string'&&/^(p\d{2}|smoke|models|auth)$/.test(row.part_id))safe.part_id=row.part_id;
  if([LUNA,'gemma'].includes(row.model as string))safe.model=row.model;
  if(statuses.has(row.terminal_status as string))safe.terminal_status=row.terminal_status;
  if(row.error_code!==undefined)safe.error_code=safeCode(row.error_code);
  return JSON.stringify(safe)+'\n';
}
