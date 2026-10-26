import { expect, test } from 'bun:test';
import { requestOptions } from './adapter.ts';
// Regression (S552 real run P4): a reused keep-alive socket never re-emits 'connect', so the connect timer fired on Gemma p02.
// send() builds every http(s) request through requestOptions(); each must use a fresh socket (agent:false).
test('every request uses a fresh socket (agent:false), never the pooled keep-alive agent',()=>{
 for(const m of ['GET','POST'] as const)expect(requestOptions(m,{}).agent).toBe(false);
});
