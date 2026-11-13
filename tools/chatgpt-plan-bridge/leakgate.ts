/**
 * Leak gate (design §4): every outbound text is scanned by two pinned detectors before any upstream connection.
 * Both must return clean; any detector error or timeout is a scanner failure and blocks sending.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type LeakConfig = { python: string; detector_check: string; redactor: string; redactor_sha256: string; gitleaks: string; tmp_dir: string; timeout_ms: number };
export type LeakResult = { clean: true } | { clean: false; detector: 'redactor' | 'gitleaks'; rules: string[] } | { error: string };
export type MaskResult = { parts: string[]; rules: string[]; spans: number } | { unmaskable: string } | { error: string };
export const MASK = (rule: string) => `[REDACTED-BY-BRIDGE:${rule}]`;

async function run(cmd: string[], input: string | undefined, timeoutMs: number) {
  const p = Bun.spawn(cmd, { stdin: input === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'ignore', env: { PATH: '/usr/bin:/bin' } });
  if (input !== undefined && p.stdin) { p.stdin.write(input); p.stdin.end(); }
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  clearTimeout(timer);
  return { out, code };
}

export async function scan(text: string, c: LeakConfig): Promise<LeakResult> {
  try {
    const r = await run([c.python, '-I', c.detector_check, c.redactor, c.redactor_sha256], text, c.timeout_ms);
    if (r.code !== 0) return { error: 'redactor_failed' };
    const d = JSON.parse(r.out);
    if (d.hit) return { clean: false, detector: 'redactor', rules: d.rules.map(String) };
  } catch { return { error: 'redactor_failed' }; }
  const f = await gitleaks(text, c);
  if ('error' in f) return f;
  if (f.length) return { clean: false, detector: 'gitleaks', rules: f.map((x: any) => String(x.RuleID)) };
  return { clean: true };
}

// The raw report (it holds the matched values) lives only in a 0600 temp dir that is removed on every path.
async function gitleaks(text: string, c: LeakConfig): Promise<any[] | { error: string }> {
  const dir = mkdtempSync(join(c.tmp_dir, 'scan-'));
  try {
    writeFileSync(join(dir, 'outbound.txt'), text, { mode: 0o600 });
    const report = join(dir, 'report.json');
    const r = await run([c.gitleaks, 'dir', join(dir, 'outbound.txt'), '--no-banner', '--report-format', 'json', '--report-path', report, '--exit-code', '0'], undefined, c.timeout_ms);
    if (r.code !== 0) return { error: 'gitleaks_failed' };
    const findings = JSON.parse(readFileSync(report, 'utf8'));
    return Array.isArray(findings) ? findings : { error: 'gitleaks_failed' };
  } catch { return { error: 'gitleaks_failed' }; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * One masking pass for gitleaks hits (S590): every finding's exact Secret is replaced literally, longest first, in the
 * part that holds it. A finding with no usable Secret, or a Secret that no single part contains (it crosses the join),
 * makes the request unmaskable; the caller quarantines it. Redactor hits are never masked here. The caller must rescan.
 */
export async function maskGitleaks(parts: string[], c: LeakConfig): Promise<MaskResult> {
  const f = await gitleaks(parts.join('\n\n'), c);
  if ('error' in f) return f;
  if (!f.length) return { unmaskable: 'no_findings' };
  const rule = new Map<string, string>();
  for (const x of f) {
    const v = typeof x?.Secret === 'string' ? x.Secret : '';
    if (v.length < 8 || /REDACTED/.test(v)) return { unmaskable: 'unusable_finding' };
    if (!rule.has(v)) rule.set(v, String(x.RuleID));
  }
  const values = [...rule.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  if (values.some(v => !parts.some(p => p.includes(v)))) return { unmaskable: 'cross_part_or_unmatched' };
  let spans = 0;
  const out = parts.map(p => { for (const v of values) { const n = p.split(v).length - 1; if (n) { spans += n; p = p.split(v).join(MASK(rule.get(v)!)); } } return p; });
  return { parts: out, rules: [...new Set(rule.values())].sort(), spans };
}
