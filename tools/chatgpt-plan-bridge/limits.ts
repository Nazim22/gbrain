/**
 * Runaway limits (design §5). Owner waived an allowance budget; these are anomaly ceilings, durable across restarts
 * (write-temp + fsync + rename on every admission; synchronous, so admissions cannot interleave inside the process).
 */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** usd_micro_per_day (API-key mode only): a STRICT ceiling on reserved-plus-settled spend per UTC admission day, in micro-dollars. */
export type Ceilings = { per_hour: number; per_day: number; concurrency: number; usd_micro_per_day?: number };
type State = { hour_start: number; hour: number; day_start: number; day: number; spend?: Record<string, number> };
/** `settle` (API-key mode only) belongs to this one admission and works once: it replaces THIS reservation by the actual cost. */
export type Admission = { ok: true; release: () => void; day?: string; reserved?: number; settle?: (actualMicro: number) => void }
  | { ok: false; code: 'runaway_guard' | 'busy' | 'daily_budget' | 'budget_state_unavailable'; retryAfterS: number };
/** The spend state is missing, unreadable or malformed, or a settlement does not fit it. Never repaired or reset in code. */
export class BudgetStateError extends Error { constructor(m: string) { super(m); } }
export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const isMicro = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const isDay = (k: string) => /^\d{4}-\d{2}-\d{2}$/.test(k) && !Number.isNaN(Date.parse(`${k}T00:00:00Z`)) && utcDay(Date.parse(`${k}T00:00:00Z`)) === k;
/** A rename is durable only once its directory entry is: fsync the parent directory too. */
export function fsyncDir(dir: string) { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
const HOUR = 3_600_000, DAY = 86_400_000;

export class Limits {
  private inflight = 0;
  constructor(private path: string, private c: Ceilings, private now: () => number = Date.now) {}
  private read(): State {
    try { const s = JSON.parse(readFileSync(this.path, 'utf8')); if ([s.hour_start, s.hour, s.day_start, s.day].every(Number.isFinite)) return s; } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const t = this.now(); return { hour_start: t, hour: 0, day_start: t, day: 0 };
  }
  private write(s: State) {
    const tmp = `${this.path}.tmp`, fd = openSync(tmp, 'w', 0o600);
    try { writeSync(fd, JSON.stringify(s)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.path);
    fsyncDir(dirname(this.path));
  }
  /** API-key mode read: no fresh start. A missing file, bad JSON, bad counters or a bad spend map all refuse. */
  private readStrict(): State & { spend: Record<string, number> } {
    let s: any;
    try { s = JSON.parse(readFileSync(this.path, 'utf8')); } catch { throw new BudgetStateError('counters unreadable'); }
    if (!s || typeof s !== 'object' || ![s.hour_start, s.hour, s.day_start, s.day].every(isMicro)) throw new BudgetStateError('counters malformed');
    if (!s.spend || typeof s.spend !== 'object' || Array.isArray(s.spend)) throw new BudgetStateError('spend state missing');
    for (const [k, v] of Object.entries(s.spend)) if (!isDay(k) || !isMicro(v)) throw new BudgetStateError('spend state malformed');
    return s;
  }
  /**
   * `reserveMicro` (API-key mode): this request's MAXIMUM cost is added to the admission day's spend in the SAME durable
   * write as the call counters, before anything is sent. Over the ceiling = refused, nothing written.
   */
  admit(reserveMicro?: number): Admission {
    if (this.inflight >= this.c.concurrency) return { ok: false, code: 'busy', retryAfterS: 5 };
    const t = this.now();
    let s: State;
    if (reserveMicro === undefined) s = this.read();
    else {
      const cap = this.c.usd_micro_per_day;
      if (!isMicro(reserveMicro) || !isMicro(cap)) return { ok: false, code: 'budget_state_unavailable', retryAfterS: 3600 };
      try { s = this.readStrict(); } catch (e) { if (e instanceof BudgetStateError) return { ok: false, code: 'budget_state_unavailable', retryAfterS: 3600 }; throw e; }
    }
    if (t - s.hour_start >= HOUR) { s.hour_start = t; s.hour = 0; }
    if (t - s.day_start >= DAY) { s.day_start = t; s.day = 0; }
    if (s.hour >= this.c.per_hour) return { ok: false, code: 'runaway_guard', retryAfterS: Math.ceil((s.hour_start + HOUR - t) / 1000) };
    if (s.day >= this.c.per_day) return { ok: false, code: 'runaway_guard', retryAfterS: Math.ceil((s.day_start + DAY - t) / 1000) };
    let day: string | undefined;
    if (reserveMicro !== undefined) {
      day = utcDay(t);
      const spent = s.spend![day] ?? 0;
      if (spent + reserveMicro > this.c.usd_micro_per_day!) return { ok: false, code: 'daily_budget', retryAfterS: Math.ceil((Date.parse(`${day}T00:00:00Z`) + DAY - t) / 1000) };
      s.spend![day] = spent + reserveMicro;
    }
    s.hour++; s.day++; this.write(s);
    this.inflight++;
    let released = false;
    let settled = false;
    const settle = reserveMicro === undefined ? undefined : (actualMicro: number) => {
      if (settled) throw new BudgetStateError('reservation already settled');
      settled = true;   // spent even when the write below refuses: this reservation is never refunded twice
      this.settleOnce(day!, reserveMicro, actualMicro);
    };
    return { ok: true, day, reserved: reserveMicro, settle, release: () => { if (!released) { released = true; this.inflight--; } } };
  }
  /**
   * Replace one reservation by the actual cost (never more than the reservation), read-modify-write against the CURRENT
   * state. Only the admission day's entry changes, whatever today's date is. Synchronous: settlements cannot interleave.
   */
  private settleOnce(day: string, reservedMicro: number, actualMicro: number) {
    if (!isMicro(reservedMicro) || !isMicro(actualMicro) || actualMicro > reservedMicro) throw new BudgetStateError('settlement out of range');
    const s = this.readStrict();
    const spent = s.spend[day];
    if (!isMicro(spent) || spent < reservedMicro) throw new BudgetStateError('settlement does not fit the recorded spend');
    s.spend[day] = spent - reservedMicro + actualMicro;
    this.write(s);
  }
  snapshot() { return { ...this.read(), inflight: this.inflight, ceilings: this.c }; }
}
