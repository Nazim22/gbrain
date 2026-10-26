import { expect, test } from 'bun:test';
import { mkdtemp, rm, stat, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { TokenStore, beginLogin, finishLogin, revoke, type Credentials } from './auth.ts';
import { Budget } from './adapter.ts';
const opaque = () => randomBytes(32).toString('base64url');
const fixture = ():Credentials => ({client_id:'oaiapp_fixture',subject:'fixture-subject',issuer:'https://auth.openai.com',host_id:`urn:uuid:${randomUUID()}`,access_token:opaque(),refresh_token:opaque(),id_token:opaque(),expires_at:0,scopes:['chatgpt.tokens.use.direct','resource.invoke']});
async function temp() { return mkdtemp(join(process.env.TMPDIR!, 's552-auth-')); }
test('token store is owner-only and refresh is flock-serialized with atomic replacement', async()=>{
  const dir=await temp();try {
    const store=new TokenStore(dir), original=fixture();await store.save(original);
    let calls=0;const budget=new Budget();
    const sender=async()=>{calls++;await Bun.sleep(20);return {status:200,raw:Buffer.from(JSON.stringify({access_token:opaque(),refresh_token:opaque(),expires_in:3600,token_type:'Bearer'}))};};
    const results=await Promise.all([store.refresh(sender,budget),store.refresh(sender,budget)]);
    expect(calls).toBe(1);expect(results[0].access_token).toBe(results[1].access_token);
    expect((await stat(join(dir,'credentials.json'))).mode&0o777).toBe(0o600);expect((await stat(dir)).mode&0o777).toBe(0o700);
    expect((await store.load()).refresh_token).not.toBe(original.refresh_token);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('unknown refresh persists stop marker and cannot be silently retried', async()=>{
  const dir=await temp();try {
    const store=new TokenStore(dir);await store.save(fixture());let calls=0;
    const fail=async()=>{calls++;throw Error('untrusted response');};
    await expect(store.refresh(fail,new Budget())).rejects.toThrow('REFRESH-UNKNOWN');
    await expect(store.refresh(fail,new Budget())).rejects.toThrow('REFRESH-PENDING');expect(calls).toBe(1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('login validates state, PKCE, nonce, signature, scopes and issued client before persistence',async()=>{
  const dir=await temp();try{
    const store=new TokenStore(dir), pending=await beginLogin(store,1455);
    const url=new URL(pending.url);expect(url.searchParams.get('code_challenge_method')).toBe('S256');expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback');
    const pair=await generateKeyPair('RS256'), key=await exportJWK(pair.publicKey);key.kid='fixture';key.alg='RS256';
    let exchanges=0;
    const callback=(state=pending.state)=>new URL(`http://127.0.0.1:1455/auth/callback?state=${state}&code=${opaque()}&client_id=oaiapp_fixture`);
    const sender=async(url:string,body:unknown)=>{
      if(url.endsWith('jwks.json'))return {status:200,raw:Buffer.from(JSON.stringify({keys:[key]}))};
      exchanges++;const form=new URLSearchParams(body as string);expect(form.get('code_verifier')).toBe(pending.verifier);
      const id=await new SignJWT({nonce:pending.nonce}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer('https://auth.openai.com').setAudience('oaiapp_fixture').setSubject('fixture-subject').setExpirationTime('1h').sign(pair.privateKey);
      return {status:200,raw:Buffer.from(JSON.stringify({id_token:id,access_token:opaque(),refresh_token:opaque(),expires_in:3600,token_type:'Bearer',scope:'openid resource.invoke chatgpt.tokens.use.direct offline_access'}))};
    };
    await expect(finishLogin(store,pending,callback('wrong'),sender,new Budget())).rejects.toThrow('OAUTH-STATE');expect(exchanges).toBe(0);
    await finishLogin(store,pending,callback(),sender,new Budget());expect((await store.load()).subject).toBe('fixture-subject');
    expect(exchanges).toBe(1);
    for(const fault of ['nonce','audience','issuer','signature','scope']) {
      const isolated=new TokenStore(join(dir,fault)),p=await beginLogin(isolated,1455);
      const wrong=await generateKeyPair('RS256');
      const id=await new SignJWT({nonce:fault==='nonce'?'wrong':p.nonce}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer(fault==='issuer'?'https://invalid.example':'https://auth.openai.com').setAudience(fault==='audience'?'wrong':'oaiapp_fixture').setSubject('fixture-subject').setExpirationTime('1h').sign(fault==='signature'?wrong.privateKey:pair.privateKey);
      const broken=async(url:string)=>url.endsWith('jwks.json')?{status:200,raw:Buffer.from(JSON.stringify({keys:[key]}))}:{status:200,raw:Buffer.from(JSON.stringify({id_token:id,access_token:opaque(),refresh_token:opaque(),expires_in:3600,token_type:'Bearer',scope:fault==='scope'?'openid':'openid resource.invoke chatgpt.tokens.use.direct'}))};
      const cb=new URL(`${p.redirect}?state=${p.state}&code=${opaque()}&client_id=oaiapp_fixture`);
      await expect(finishLogin(isolated,p,cb,broken,new Budget())).rejects.toThrow();
      await expect(access(join(isolated.dir,'credentials.json'))).rejects.toThrow();
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('revocation checks happen before deletion; unknown revocation retains credentials',async()=>{
  const dir=await temp();try{
    const store=new TokenStore(dir);await store.save(fixture());const trace:string[]=[];
    const sender=async(url:string)=>{await access(join(dir,'credentials.json'));trace.push(url.endsWith('/models')?'models':'refresh');return url.endsWith('/models')?{status:401,raw:Buffer.from('{}')}:{status:400,raw:Buffer.from(JSON.stringify({error:'invalid_grant'}))};};
    await revoke(store,true,sender,new Budget());expect(trace).toEqual(['refresh','models']);await expect(access(join(dir,'credentials.json'))).rejects.toThrow();
    await store.save(fixture());await expect(revoke(store,true,async()=>{throw Error();},new Budget())).rejects.toThrow('REVOCATION-UNKNOWN');
    await access(join(dir,'credentials.json'));
  }finally{await rm(dir,{recursive:true,force:true});}
});
