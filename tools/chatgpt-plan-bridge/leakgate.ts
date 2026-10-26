/**
 * Leak gate (design §4): every outbound text is scanned by two pinned detectors before any upstream connection.
 * Both must return clean; any detector error or timeout is a scanner failure and blocks sending.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type LeakConfig = { python: string; detector_check: string; redactor: string; redactor_sha256: string; gitleaks: string; tmp_dir: string; timeout_ms: number };
export type LeakResult = { clean: true } | { clean: false; detector: 'redactor' | 'gitleaks'; rules: string[] } | { error: string };

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
  const dir = mkdtempSync(join(c.tmp_dir, 'scan-'));
  try {
    writeFileSync(join(dir, 'outbound.txt'), text, { mode: 0o600 });
    const report = join(dir, 'report.json');
    const r = await run([c.gitleaks, 'dir', join(dir, 'outbound.txt'), '--no-banner', '--report-format', 'json', '--report-path', report, '--exit-code', '0'], undefined, c.timeout_ms);
    if (r.code !== 0) return { error: 'gitleaks_failed' };
    const findings = JSON.parse(readFileSync(report, 'utf8'));
    if (!Array.isArray(findings)) return { error: 'gitleaks_failed' };
    if (findings.length) return { clean: false, detector: 'gitleaks', rules: findings.map((f: any) => String(f.RuleID)) };
    return { clean: true };
  } catch { return { error: 'gitleaks_failed' }; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
