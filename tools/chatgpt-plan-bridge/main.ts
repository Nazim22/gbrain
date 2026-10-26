/** Entry point: `bun main.ts <config.json>`. Binds 127.0.0.1 only. */
import { readFileSync } from 'node:fs';
import { makeHandler, loadConfig } from './bridge.ts';
import { Limits } from './limits.ts';
import { scan } from './leakgate.ts';
import { sendUpstream } from './upstream.ts';
import { TokenStore } from '../../eval/chatgpt-plan/auth.ts';
import { Budget, send } from '../../eval/chatgpt-plan/adapter.ts';

const cfg = loadConfig(process.argv[2] ?? '');
const store = new TokenStore(cfg.auth_dir);
const callerSecret = Buffer.from(readFileSync(cfg.caller_secret_file, 'utf8').trim());
if (callerSecret.length < 32) throw Error('CALLER-SECRET-TOO-SHORT');

async function accessToken() {
  const c = await store.load();
  if (c.expires_at > Date.now() + 120_000) return c.access_token;
  return (await store.refresh(send, new Budget())).access_token; // flock-serialised, refresh.pending fail-closed (reviewed auth.ts)
}

const handle = makeHandler(cfg, { accessToken, upstream: sendUpstream, scan: t => scan(t, cfg.leak), limits: new Limits(`${cfg.state_dir}/counters.json`, cfg.ceilings), callerSecret });
Bun.serve({ hostname: '127.0.0.1', port: cfg.port, fetch: handle, idleTimeout: 255 });
console.log(JSON.stringify({ event: 'listening', host: '127.0.0.1', port: cfg.port, routes: Object.keys(cfg.routes) }));
