import { expect,test } from 'bun:test';
import { send,MAX_BYTES } from './adapter.ts';
import { spawnSync } from 'bun';
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
});
