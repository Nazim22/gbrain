import { mkdir, open, lstat, readFile, rename, unlink, realpath } from 'node:fs/promises';
import { join, resolve, parse } from 'node:path';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { API, TOKEN, Budget, send, guardedRequest, LIMITS, type Sender } from './adapter.ts';

export type Credentials={client_id:string;subject:string;issuer:string;host_id:string;access_token:string;refresh_token:string;id_token:string;expires_at:number;scopes:string[]};
const JWKS='https://auth.openai.com/.well-known/jwks.json';
export class TokenStore {
  constructor(readonly dir:string) {}
  async prepare() {
    if(!resolve(this.dir).startsWith('/'))throw Error('AUTH-PATH');
    let cursor=resolve(this.dir);
    while(cursor!==parse(cursor).root) {try{if((await lstat(cursor)).isSymbolicLink())throw Error('AUTH-SYMLINK');}catch(e:any){if(e.code!=='ENOENT')throw e;}cursor=resolve(cursor,'..');}
    await mkdir(this.dir,{mode:0o700,recursive:true});
    const st=await lstat(this.dir);if(st.uid!==process.getuid!() || (st.mode&0o777)!==0o700 || !st.isDirectory())throw Error('AUTH-MODE');
    if(await realpath(this.dir)!==resolve(this.dir))throw Error('AUTH-SYMLINK');
  }
  async atomic(name:string,value:unknown) {
    await this.prepare();
    const path=join(this.dir,name),tmp=join(this.dir,`.${name}-${randomUUID()}`);
    const fd=await open(tmp,'wx',0o600);
    try{await fd.writeFile(JSON.stringify(value));await fd.sync();}finally{await fd.close();}
    try{await rename(tmp,path);const parent=await open(this.dir,'r');try{await parent.sync();}finally{await parent.close();}}finally{await unlink(tmp).catch(()=>{});}
  }
  async load():Promise<Credentials> {
    await this.prepare();const p=join(this.dir,'credentials.json'),st=await lstat(p);
    if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid!()||(st.mode&0o777)!==0o600)throw Error('AUTH-MODE');
    const data=JSON.parse(await readFile(p,'utf8'));
    if(!data.client_id?.startsWith('oaiapp_')||data.issuer!=='https://auth.openai.com'||!data.subject||!data.host_id||!data.access_token||!data.refresh_token||!data.scopes?.includes('chatgpt.tokens.use.direct'))throw Error('AUTH-RECORD');
    return data;
  }
  async save(data:Credentials){await this.atomic('credentials.json',data);}
  async locked<T>(fn:()=>Promise<T>):Promise<T> {
    await this.prepare();const path=join(this.dir,'refresh.lock');
    const fd=await open(path,'a',0o600);await fd.close();
    const st=await lstat(path);if(st.isSymbolicLink()||st.uid!==process.getuid!()||(st.mode&0o777)!==0o600)throw Error('LOCK-MODE');
    // flock owns the cross-process lock until stdin is closed; argv never carries secrets.
    const proc=Bun.spawn(['/usr/bin/flock','-x','-w','10',path,'/bin/sh','-c','printf ready; read -r release'],{stdin:'pipe',stdout:'pipe',stderr:'ignore',env:{PATH:'/usr/bin:/bin'}});
    const reader=proc.stdout.getReader();const ready=await reader.read();reader.releaseLock();
    if(ready.done||Buffer.from(ready.value).toString()!=='ready'){proc.stdin.end();await proc.exited;throw Error('LOCK-FAILED');}
    try{return await fn();}finally{proc.stdin.end();await proc.exited;}
  }
  async refresh(sender:Sender,budget:Budget,force=false):Promise<Credentials> {
    return this.locked(async()=>{
      const pending=join(this.dir,'refresh.pending');
      try{await lstat(pending);throw Error('REFRESH-PENDING');}catch(e:any){if(e.code!=='ENOENT')throw e;}
      const old=await this.load();if(!force&&old.expires_at>Date.now()+60_000)return old;
      budget.take('auth');await this.atomic('refresh.pending',{started_at:new Date().toISOString()});
      let wire;
      try{wire=await sender(TOKEN,new URLSearchParams({grant_type:'refresh_token',client_id:old.client_id,refresh_token:old.refresh_token,resource:API}).toString(),{},LIMITS.auth);}catch{throw Error('REFRESH-UNKNOWN');}
      let data;try{data=JSON.parse(wire.raw.toString());}catch{throw Error('REFRESH-UNKNOWN');}
      if(wire.status!==200){if(data.error==='invalid_grant'){await unlink(pending);throw Error('INVALID-GRANT');}throw Error('REFRESH-UNKNOWN');}
      if(data.token_type!=='Bearer'||typeof data.access_token!=='string'||typeof data.refresh_token!=='string'||!(data.expires_in>0))throw Error('REFRESH-UNKNOWN');
      const scopes=typeof data.scope==='string'?data.scope.split(' '):old.scopes;
      if(!scopes.includes('chatgpt.tokens.use.direct'))throw Error('REFRESH-UNKNOWN');
      const next={...old,access_token:data.access_token,refresh_token:data.refresh_token,expires_at:Date.now()+data.expires_in*1000,scopes};
      await this.save(next);await unlink(pending);return next;
    });
  }
}
export type Pending={state:string;nonce:string;verifier:string;redirect:string;client:string;host:string;url:string;subject?:string;started:number;used?:boolean};
export async function beginLogin(store:TokenStore,port:number):Promise<Pending> {
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('CALLBACK-PORT');
  await store.prepare();let host:string;
  try{host=JSON.parse(await readFile(join(store.dir,'host.json'),'utf8')).host;}catch(e:any){if(e.code!=='ENOENT')throw e;host=`urn:uuid:${randomUUID()}`;await store.atomic('host.json',{host});}
  let saved:Credentials|undefined;try{saved=await store.load();}catch(e:any){if(e.code!=='ENOENT')throw e;}
  const state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
  const redirect=`http://127.0.0.1:${port}/auth/callback`,client=saved?.client_id??'dynamic_agent_client';
  const url=new URL('https://auth.openai.com/api/accounts/authorize');
  const params:Record<string,string>={client_id:client,ext_agent_host_id:host,response_type:'code',redirect_uri:redirect,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',resource:API,state,nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')};
  if(!saved)params.agent_name_hint='gbrain-local';
  url.search=new URLSearchParams(params).toString();return {state,nonce,verifier,redirect,client,host,url:url.toString(),subject:saved?.subject,started:Date.now()};
}
export async function finishLogin(store:TokenStore,p:Pending,callback:URL,sender:Sender=send,budget=new Budget()) {
  const actual=callback.searchParams.get('state')??'';
  if(actual.length!==p.state.length||!timingSafeEqual(Buffer.from(actual),Buffer.from(p.state)))throw Error('OAUTH-STATE');
  if(p.used||Date.now()-p.started>300_000)throw Error('OAUTH-EXPIRED');
  p.used=true;
  if(callback.origin+callback.pathname!==p.redirect || callback.searchParams.get('error'))throw Error('OAUTH-DENIED');
  const client=callback.searchParams.get('client_id')??(p.client!=='dynamic_agent_client'?p.client:'');
  if(!client.startsWith('oaiapp_')||(p.client!=='dynamic_agent_client'&&client!==p.client))throw Error('OAUTH-CLIENT');
  const code=callback.searchParams.get('code');if(!code)throw Error('OAUTH-CODE');
  budget.take('auth');
  const wire=await guardedRequest(TOKEN,new URLSearchParams({grant_type:'authorization_code',client_id:client,code,code_verifier:p.verifier,redirect_uri:p.redirect,resource:API}).toString(),sender,{},LIMITS.auth);
  const data=JSON.parse(wire.raw.toString());
  if(data.token_type!=='Bearer'||!data.access_token||!data.refresh_token||!data.id_token||!(data.expires_in>0)||typeof data.scope!=='string')throw Error('OAUTH-TOKENS');
  budget.take('auth');const jwks=await guardedRequest(JWKS,undefined,sender,{},LIMITS.auth);
  const verified=await jwtVerify(data.id_token,createLocalJWKSet(JSON.parse(jwks.raw.toString())),{issuer:'https://auth.openai.com',audience:client,algorithms:['RS256'],requiredClaims:['exp','sub','nonce']});
  if(verified.payload.nonce!==p.nonce||!verified.payload.sub||(p.subject&&verified.payload.sub!==p.subject))throw Error('OAUTH-IDENTITY');
  const scopes=data.scope.split(' ');if(!scopes.includes('chatgpt.tokens.use.direct')||!scopes.includes('resource.invoke'))throw Error('OAUTH-SCOPES');
  await store.save({client_id:client,subject:verified.payload.sub,issuer:'https://auth.openai.com',host_id:p.host,access_token:data.access_token,refresh_token:data.refresh_token,id_token:data.id_token,expires_at:Date.now()+data.expires_in*1000,scopes});
}
/** Operator removes app first. One refresh + one model-list check; no retry or local-delete substitute. */
export async function revoke(store:TokenStore,accountRemovalConfirmed:boolean,sender:Sender=send,budget=new Budget()) {
  if(!accountRemovalConfirmed)throw Error('ACCOUNT-REMOVAL-EVIDENCE-REQUIRED');
  return store.locked(async()=>{
    const old=await store.load();let refresh,models;
    try {
      budget.take('auth');refresh=await sender(TOKEN,new URLSearchParams({grant_type:'refresh_token',client_id:old.client_id,refresh_token:old.refresh_token,resource:API}).toString(),{},LIMITS.auth);
      budget.take('auth');models=await sender(`${API}/models`,undefined,{Authorization:`Bearer ${old.access_token}`},LIMITS.auth);
    }catch{throw Error('REVOCATION-UNKNOWN');}
    let data;try{data=JSON.parse(refresh.raw.toString());}catch{throw Error('REVOCATION-UNKNOWN');}
    if(refresh.status!==400||data.error!=='invalid_grant'||![200,401].includes(models.status))throw Error('REVOCATION-UNKNOWN');
    await unlink(join(store.dir,'credentials.json'));
    await unlink(join(store.dir,'refresh.pending')).catch((e:any)=>{if(e.code!=='ENOENT')throw e;});
    try{await lstat(join(store.dir,'credentials.json'));throw Error('DELETE-READBACK');}catch(e:any){if(e.code!=='ENOENT')throw e;}
    return {renewable_session:'revoked',access_token:models.status===200?'still-valid-until-expiry':'rejected',local_credentials:'absent'};
  });
}
