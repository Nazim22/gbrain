import { expect,test } from 'bun:test';
import { send,MAX_BYTES } from './adapter.ts';
import { spawnSync } from 'bun';
import { callbackListener } from './cli.ts';
test('callback listener binds only IPv4 loopback and drains the successful response',async()=>{
 let callbacks=0;const server=callbackListener(async()=>{callbacks++;});
 try {
  expect(server.hostname).toBe('127.0.0.1');expect(server.port).toBe(1455);
  const notFound=await fetch('http://127.0.0.1:1455/not-a-callback');expect(notFound.status).toBe(404);expect(callbacks).toBe(0);
  const response=await fetch('http://127.0.0.1:1455/auth/callback');
  await server.stop();expect(response.status).toBe(200);expect(await response.text()).toBe('Sign-in completed. Close this window.');expect(callbacks).toBe(1);
 }finally{await server.stop(true);}
});
test('native transport enforces body cap, deadline, and rejects redirects without following',async()=>{
 let requests=0,mode='redirect';
 const server=Bun.serve({hostname:'127.0.0.1',port:8084,fetch(){requests++;if(mode==='redirect')return new Response('',{status:302,headers:{location:'https://api.openai.com/v1/models'}});if(mode==='size')return new Response('x'.repeat(MAX_BYTES+1));return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('partial'));}}));}});
 try {
  await expect(send('http://127.0.0.1:8084/v1/chat/completions',{}, {},{connect:100,request:100})).rejects.toThrow('REDIRECT');expect(requests).toBe(1);
  mode='size';await expect(send('http://127.0.0.1:8084/v1/chat/completions',{}, {},{connect:100,request:100})).rejects.toThrow('OUTPUT-BOUND');
  mode='hang';await expect(send('http://127.0.0.1:8084/v1/chat/completions',{}, {},{connect:100,request:30})).rejects.toThrow('REQUEST-TIMEOUT');
 }finally{await server.stop(true);}
});
test('rules order permits only Gemma/resolver before private ranges then public HTTPS',()=>{
 const run=spawnSync(['/bin/bash',`${import.meta.dir}/launch.sh`,'print-rules','9999','1.1.1.1','s552_fixture'],{stdout:'pipe',stderr:'pipe'});
 expect(run.exitCode).toBe(0);const text=run.stdout.toString();
 expect(text.indexOf('127.0.0.1 tcp dport 8084 accept')).toBeLessThan(text.indexOf('ip daddr {'));
 expect(text.indexOf('ip daddr {')).toBeLessThan(text.indexOf('tcp dport 443 accept'));
 expect(text.indexOf('ip6 daddr {')).toBeLessThan(text.indexOf('tcp dport 443 accept'));
 expect(text).toContain('meta skuid 9999');expect(text).toContain('counter drop');
 expect(text).not.toContain('ct state established');
});
test('consent permits only fixed IPv4-loopback established reply traffic before private drops',()=>{
 const run=spawnSync(['/bin/bash',`${import.meta.dir}/launch.sh`,'print-rules','9999','1.1.1.1','s552_fixture','consent'],{stdout:'pipe',stderr:'pipe'});
 expect(run.exitCode).toBe(0);const text=run.stdout.toString();
 const exception='ip saddr 127.0.0.1 ip daddr 127.0.0.1 tcp sport 1455 ct state established ct direction reply accept';
 expect(text).toContain(exception);
 expect(text.indexOf(exception)).toBeLessThan(text.indexOf('ip daddr {'));
 expect(text.match(/ct state established/g)?.length).toBe(1);
 expect(text).toContain('meta skuid 9999 jump s552_fixture');
});
test('cloudArms binds run-go cloud_models to exact allowlisted ids',async()=>{
 const { cloudArms } = await import('./cli.ts');
 expect(cloudArms(undefined)).toEqual(['luna']);
 expect(cloudArms(['gpt-6-luna','gpt-6.1-sol'])).toEqual(['luna','sol']);
 for(const bad of [[],['gpt-6-luna','gpt-6-luna'],['gpt-6-sol'],'gpt-6-luna',[1]])expect(()=>cloudArms(bad)).toThrow('CLOUD-MODELS');
});
test('a cloud_models run requires a matching sealed protocol addendum',async()=>{
 const { addendumOk } = await import('./cli.ts');const { sha } = await import('./harness.ts');
 const doc=Buffer.from('addendum');
 expect(addendumOk({},undefined)).toBe(true);
 expect(addendumOk({cloud_models:['gpt-6-luna','gpt-6.1-sol']},doc)).toBe(false);
 expect(addendumOk({cloud_models:['gpt-6-luna','gpt-6.1-sol'],protocol_addendum_sha256:sha(doc)},undefined)).toBe(false);
 expect(addendumOk({cloud_models:['gpt-6-luna','gpt-6.1-sol'],protocol_addendum_sha256:sha(Buffer.from('other'))},doc)).toBe(false);
 expect(addendumOk({cloud_models:['gpt-6-luna','gpt-6.1-sol'],protocol_addendum_sha256:sha(doc)},doc)).toBe(true);
});
