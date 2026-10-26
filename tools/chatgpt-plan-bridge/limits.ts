/**
 * Runaway limits (design §5). Owner waived an allowance budget; these are anomaly ceilings, durable across restarts
 * (write-temp + fsync + rename on every admission; synchronous, so admissions cannot interleave inside the process).
 */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';

export type Ceilings = { per_hour: number; per_day: number; concurrency: number };
type State = { hour_start: number; hour: number; day_start: number; day: number };
export type Admission = { ok: true; release: () => void } | { ok: false; code: 'runaway_guard' | 'busy'; retryAfterS: number };
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
  }
  admit(): Admission {
    if (this.inflight >= this.c.concurrency) return { ok: false, code: 'busy', retryAfterS: 5 };
    const t = this.now(), s = this.read();
    if (t - s.hour_start >= HOUR) { s.hour_start = t; s.hour = 0; }
    if (t - s.day_start >= DAY) { s.day_start = t; s.day = 0; }
    if (s.hour >= this.c.per_hour) return { ok: false, code: 'runaway_guard', retryAfterS: Math.ceil((s.hour_start + HOUR - t) / 1000) };
    if (s.day >= this.c.per_day) return { ok: false, code: 'runaway_guard', retryAfterS: Math.ceil((s.day_start + DAY - t) / 1000) };
    s.hour++; s.day++; this.write(s);
    this.inflight++;
    let released = false;
    return { ok: true, release: () => { if (!released) { released = true; this.inflight--; } } };
  }
  snapshot() { return { ...this.read(), inflight: this.inflight, ceilings: this.c }; }
}
