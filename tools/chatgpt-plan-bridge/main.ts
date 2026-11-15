/** Entry point: `bun main.ts <config.json>`. Binds 127.0.0.1 only. */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { makeHandler, loadConfig } from './bridge.ts';
import { Limits } from './limits.ts';
import { scan } from './leakgate.ts';
import { sendUpstream } from './upstream.ts';
import { TokenStore } from '../../eval/chatgpt-plan/auth.ts';
import { Budget, send } from '../../eval/chatgpt-plan/adapter.ts';

const cfg = loadConfig(process.argv[2] ?? '');
const callerSecret = Buffer.from(readFileSync(cfg.caller_secret_file, 'utf8').trim());
if (callerSecret.length < 32) throw Error('CALLER-SECRET-TOO-SHORT');

const paid = cfg.upstream.auth === 'api_key';
let accessToken: () => Promise<string>;
if (paid) {
  // Paid API mode: the bearer is a static key read once. The plan TokenStore is never constructed, so no OAuth refresh
  // (and no call to auth.openai.com) can happen in this mode. The key is never logged or put in an error.
  const key = readFileSync(cfg.upstream.api_key_file!, 'utf8').trim();
  if (key.length < 20 || key.length > 400 || /\s/.test(key)) throw Error('API-KEY-FILE-INVALID');
  accessToken = async () => key;
  // One paid writer per state directory: a second process sharing counters.json could not serialise reservations.
  const pidFile = `${cfg.state_dir}/paid-writer.pid`;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; } };
  if (existsSync(pidFile)) {
    const other = Number(readFileSync(pidFile, 'utf8').trim());
    if (Number.isInteger(other) && other > 0 && other !== process.pid && alive(other)) throw Error('PAID-WRITER-ALREADY-RUNNING');
    unlinkSync(pidFile);
  }
  writeFileSync(pidFile, String(process.pid), { flag: 'wx', mode: 0o600 });
  process.on('exit', () => { try { if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) unlinkSync(pidFile); } catch { /* already gone */ } });
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => process.exit(0));
} else {
  const store = new TokenStore(cfg.auth_dir);
  accessToken = async () => {
    const c = await store.load();
    if (c.expires_at > Date.now() + 120_000) return c.access_token;
    return (await store.refresh(send, new Budget())).access_token; // flock-serialised, refresh.pending fail-closed (reviewed auth.ts)
  };
}

const handle = makeHandler(cfg, { accessToken, upstream: sendUpstream, scan: t => scan(t, cfg.leak), limits: new Limits(`${cfg.state_dir}/counters.json`, cfg.ceilings), callerSecret });
Bun.serve({ hostname: '127.0.0.1', port: cfg.port, fetch: handle, idleTimeout: 255 });
console.log(JSON.stringify({ event: 'listening', host: '127.0.0.1', port: cfg.port, routes: Object.keys(cfg.routes), auth: paid ? 'api_key' : 'plan' }));
