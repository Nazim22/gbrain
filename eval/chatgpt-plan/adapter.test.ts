import { expect, test } from 'bun:test';
import { lunaBody, parseLuna, gemmaBody, parseGemma, Budget, guardedRequest, encodeLog } from './adapter.ts';
const event = (type: string, response: unknown = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`;
const done = (text = '[]') => event('response.completed', { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 7, output_tokens: 2 } });
test('completed valid output alone is accepted', () => {
  expect(parseLuna(done()).status).toBe('SUCCESS');
  expect(parseLuna(done('not JSON')).status).toBe('FAILED-SCHEMA');
});
test('terminal failures never promote partial content', () => {
  for (const [wire, status] of [[event('response.failed'), 'FAILED'], [event('response.incomplete'), 'FAILED-TRUNCATED'], ['data: {"type":"response.output_text.delta","delta":"[]"}\n\n', 'UNKNOWN']] as const) {
    expect(parseLuna(wire).status).toBe(status);
  }
});
test('request bodies pin settings and share exact prompt bytes', () => {
  const prompt = { system: 'exact system', messages: [{ role: 'user' as const, content: 'exact user' }] };
  const luna = lunaBody(prompt), gemma = gemmaBody(prompt);
  expect(luna.instructions).toBe(gemma.messages[0].content);
  expect(luna.input[0].content).toBe(gemma.messages[1].content);
  expect(luna.model).toBe('gpt-6-luna'); expect(luna.reasoning.effort).toBe('minimal');
  expect(gemma.max_tokens).toBe(8192); expect(gemma.chat_template_kwargs.enable_thinking).toBe(false);
});
test('guard rejects disallowed parameters before network', async () => {
  for (const key of ['temperature', 'max_output_tokens', 'metadata', 'text', 'tools']) {
    let sent = false;
    await expect(guardedRequest('https://api.openai.com/v1/responses', { ...lunaBody({ system: 's', messages: [{role:'user',content:'u'}] }), [key]: 1 }, async () => { sent = true; throw Error(); })).rejects.toThrow('REQUEST-SHAPE');
    expect(sent).toBe(false);
  }
});
test('fixed endpoints reject alternate hosts, query strings and redirects', async () => {
  let sent = 0;
  for (const url of ['https://elsewhere.invalid/v1/responses','https://api.openai.com/v1/responses?x=1','http://api.openai.com/v1/responses']) {
    await expect(guardedRequest(url, undefined, async () => { sent++; throw Error(); })).rejects.toThrow('ENDPOINT');
  }
  expect(sent).toBe(0);
  await expect(guardedRequest('https://api.openai.com/v1/models', undefined, async () => ({status:302,raw:Buffer.from('')}))).rejects.toThrow('REDIRECT');
});
test('HTTP stop statuses never retry and error text is not exposed', async () => {
  for (const status of [401,403,429,503]) {
    let sent = 0;
    await expect(guardedRequest('https://api.openai.com/v1/models', undefined, async () => { sent++; return {status,raw:Buffer.from('private error body')}; })).rejects.toThrow(`HTTP-${status}`);
    expect(sent).toBe(1);
  }
});
test('arm and auth counters are separate, wall bounds fail closed', () => {
  let now = 0; const budget = new Budget(() => now);
  for(let i=0;i<22;i++) budget.take('luna');
  expect(() => budget.take('luna')).toThrow('REQUEST-BOUND');
  for(let i=0;i<20;i++) budget.take('gemma');
  expect(() => budget.take('gemma')).toThrow('REQUEST-BOUND');
  budget.take('auth'); expect(budget.counts).toEqual({luna:22,sol:0,gemma:20,auth:1});
  for(let i=1;i<12;i++)budget.take('auth');
  expect(()=>budget.take('auth')).toThrow('REQUEST-BOUND');
  const cloudExpired = new Budget(() => now); cloudExpired.take('luna'); now=2_700_001;
  expect(()=>cloudExpired.take('luna')).toThrow('WALL-BOUND');
  const expired = new Budget(() => now); expired.take('gemma'); now+=3_600_001;
  expect(() => expired.take('gemma')).toThrow('WALL-BOUND');
});
test('Gemma truncation and invalid/absent choice are failures', () => {
  expect(parseGemma(JSON.stringify({choices:[{message:{content:'[]'},finish_reason:'length'}]})).status).toBe('FAILED-TRUNCATED');
  expect(parseGemma(JSON.stringify({choices:[{message:{content:'[]'},finish_reason:'stop'}]})).status).toBe('SUCCESS');
  expect(parseGemma('{}').status).not.toBe('SUCCESS');
});
test('log allowlist rejects untrusted strings and excludes secrets/content', () => {
  const encoded = encodeLog({ arm:'luna', part_id:'p01', terminal_status:'SUCCESS', model:'gpt-6-luna', headers:{Authorization:'private'}, content:'private', error_code:'private arbitrary error', latency_ms:5 });
  expect(encoded).not.toContain('private'); expect(encoded).not.toContain('headers'); expect(encoded).toContain('SUCCESS');
});
test('per-model effort is frozen: swapped or unknown models are refused before sending',async()=>{
 const { cloudBody, guardedRequest, API, encodeLog } = await import('./adapter.ts');
 let sent=0;const sender=async()=>{sent++;return {status:200,raw:Buffer.from('')};};
 const p={system:'s',messages:[{role:'user' as const,content:'u'}]};
 expect(cloudBody('sol',p)).toEqual({model:'gpt-6.1-sol',instructions:'s',input:p.messages,stream:true,store:false,reasoning:{effort:'medium'}});
 await expect(guardedRequest(`${API}/responses`,{...cloudBody('sol',p),reasoning:{effort:'minimal'}},sender)).rejects.toThrow('REQUEST-SHAPE');
 await expect(guardedRequest(`${API}/responses`,{...cloudBody('luna',p),reasoning:{effort:'medium'}},sender)).rejects.toThrow('REQUEST-SHAPE');
 await expect(guardedRequest(`${API}/responses`,{...cloudBody('luna',p),model:'gpt-6-sol'},sender)).rejects.toThrow('REQUEST-SHAPE');
 expect(sent).toBe(0);
 expect(JSON.parse(encodeLog({arm:'sol',model:'gpt-6.1-sol',part_id:'p01'}))).toMatchObject({arm:'sol',model:'gpt-6.1-sol',part_id:'p01'});
});
test('the model catalog has its own 8 MB bound; model answers keep the 256 KB cap',async()=>{
 const { guardedRequest, API, GEMMA, capFor, MAX_BYTES, MODELS_MAX_BYTES, cloudBody } = await import('./adapter.ts');
 expect(capFor(`${API}/models`)).toBe(8*1024*1024);expect(capFor(`${API}/responses`)).toBe(MAX_BYTES);expect(capFor(GEMMA)).toBe(MAX_BYTES);
 const big=(n:number)=>async()=>({status:200,raw:Buffer.alloc(n,97)});
 // the P5 case: a ~1 MB catalog must pass; a model answer of the same size must still stop
 await expect(guardedRequest(`${API}/models`,undefined,big(1_000_000))).resolves.toBeDefined();
 await expect(guardedRequest(`${API}/models`,undefined,big(MODELS_MAX_BYTES+1))).rejects.toThrow('OUTPUT-BOUND');
 const p={system:'s',messages:[{role:'user' as const,content:'u'}]};
 await expect(guardedRequest(`${API}/responses`,cloudBody('luna',p),big(MAX_BYTES+1))).rejects.toThrow('OUTPUT-BOUND');
 await expect(guardedRequest(GEMMA,{},big(MAX_BYTES+1))).rejects.toThrow('OUTPUT-BOUND');
});
