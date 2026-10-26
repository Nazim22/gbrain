import { expect, test } from 'bun:test';
import { requestOptions, transport } from './adapter.ts';
// Regression (S552 real run P4): a reused keep-alive socket never re-emits 'connect', so the connect timer fired on the
// second sequential Gemma call (p02, 5,004 ms) whose response headers arrive only at completion. Same shape on a stub:
// two sequential calls; the second's headers arrive after the connect bound but well within the request deadline.
test('sequential requests whose headers arrive after the connect bound still succeed',async()=>{
 let n=0;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(){n++;if(n===2)await Bun.sleep(400);return new Response('{"ok":true}');}});
 try {
  const url=`http://127.0.0.1:${server.port}/v1/chat/completions`,bounds={connect:150,request:3000};
  const first=await transport(url,{},{},bounds);
  const second=await transport(url,{},{},bounds);
  expect([first.status,second.status]).toEqual([200,200]);expect(n).toBe(2);
 } finally { server.stop(true); }
});
test('every request uses a fresh socket (agent:false)',()=>{for(const m of ['GET','POST'] as const)expect(requestOptions(m,{}).agent).toBe(false);});
test('transport streams a catalog larger than the answer cap up to the catalog bound',async()=>{
 const { MAX_BYTES } = await import('./adapter.ts');
 // the stub URL is not /v1/models, so this pins the transport-side cap to capFor(url): an answer-sized stream still stops
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return new Response(Buffer.alloc(MAX_BYTES+10,97));}});
 try { await expect(transport(`http://127.0.0.1:${server.port}/v1/responses`,undefined,{},{connect:500,request:3000})).rejects.toThrow('OUTPUT-BOUND'); }
 finally { server.stop(true); }
});
