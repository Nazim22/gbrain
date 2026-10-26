/**
 * One real call through gbrain's own gateway to the installed bridge (CANARY-PACKET step B). Synthetic prompt, no brain
 * content. Needs LITELLM_BASE_URL + LITELLM_API_KEY in the ENVIRONMENT (never argv). Prints text, served model, usage.
 */
const { chat, configureGatewayIfUninitialized } = await import('../../../src/core/ai/gateway.ts');
if (!process.env.LITELLM_BASE_URL || !process.env.LITELLM_API_KEY) throw Error('LITELLM_BASE_URL and LITELLM_API_KEY must be set in the environment');
configureGatewayIfUninitialized();
const r = await chat({
  model: process.env.LUNA_ROUTE ?? 'litellm:gpt-6-luna@medium',
  system: 'You are a JSON-only responder.',
  messages: [{ role: 'user', content: 'Return exactly {"atoms":[]} and nothing else.' }],
  maxTokens: 256,
});
const out = { text: r.text, model: r.model, responseModel: (r as any).responseModel ?? null, stopReason: (r as any).stopReason ?? null, usage: r.usage };
console.log(JSON.stringify(out));
process.exit(r.text.includes('"atoms"') && (r as any).responseModel ? 0 : 1);
