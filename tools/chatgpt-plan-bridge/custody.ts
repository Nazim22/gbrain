/**
 * Paid-mode custody (GBRAIN-S593): how the API key file is read, and the one-writer lock on the state directory.
 * Every key-file refusal is the same generic error; nothing about the file's content ever reaches a message.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export class CustodyError extends Error { constructor(m = 'API-KEY-FILE-INVALID') { super(m); } }
const KEY_MAX = 400;

/**
 * The accepted custody: a regular file owned by `ownerUid` (root in production), mode no wider than 0640, reached only
 * through real directories owned by root or `ownerUid` that nobody else can write, and never inside `forbiddenDir`
 * (the bridge's own state). Opened without following a link; checked and read through the same descriptor, bounded.
 */
export function readKeyFile(path: string, o: { ownerUid?: number; forbiddenDir?: string } = {}): string {
  const owner = o.ownerUid ?? 0;
  if (typeof path !== 'string' || !path.startsWith('/') || resolve(path) !== path) throw new CustodyError();
  const forbid = o.forbiddenDir ? resolve(o.forbiddenDir) : null;
  if (forbid && (path === forbid || path.startsWith(`${forbid}/`))) throw new CustodyError();
  let fd: number | undefined;
  try {
    for (let d = dirname(path); ; d = dirname(d)) {
      const st = lstatSync(d);   // lstat: a symlinked component is not a directory and refuses
      if (!st.isDirectory() || (st.uid !== 0 && st.uid !== owner) || (st.mode & 0o022) !== 0) throw new CustodyError();
      if (d === '/') break;
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== owner || (st.mode & 0o137) !== 0 || st.size > KEY_MAX + 1) throw new CustodyError();
    const buf = Buffer.alloc(KEY_MAX + 2);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const key = buf.subarray(0, n).toString('latin1').replace(/\n$/, '');
    if (!/^[\x21-\x7e]{20,400}$/.test(key)) throw new CustodyError();   // printable ASCII only: no space, no control byte
    return key;
  } catch { throw new CustodyError(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * One paid writer per state directory, held by the kernel for this process's lifetime (the flock pattern of the
 * reviewed eval/chatgpt-plan/auth.ts): `flock -n` takes the lock or fails at once, and holds it until our stdin pipe
 * closes, which the kernel does when this process ends however it ends. No stale file to judge, nothing to take over.
 */
export async function holdWriterLock(stateDir: string): Promise<{ exited: Promise<number> }> {
  const path = join(stateDir, 'paid-writer.lock');
  closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600));
  const proc = Bun.spawn(['/usr/bin/flock', '-n', '-x', path, '/bin/sh', '-c', 'printf ready; read -r release'], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: { PATH: '/usr/bin:/bin' } });
  const reader = proc.stdout.getReader(); const ready = await reader.read(); reader.releaseLock();
  if (ready.done || Buffer.from(ready.value).toString() !== 'ready') { proc.stdin.end(); await proc.exited; throw Error('PAID-WRITER-ALREADY-RUNNING'); }
  return { exited: proc.exited };
}
