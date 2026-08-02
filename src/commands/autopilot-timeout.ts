export function resolveAutopilotDispatchTimeoutMs(
  baseIntervalSeconds: number,
  fullCycle: boolean,
): number {
  const intervalDerivedTimeoutMs = Math.max(baseIntervalSeconds * 2 * 1000, 300_000);
  return fullCycle
    // S400: 30min floor was shorter than the content-writing phase envelope —
    // 10/31 cycles died in 24h; one (#5926) was force-evicted mid-propose_takes,
    // kept running past eviction, and ended in a lock-token mismatch. The S400
    // atom-cap raise (3→8, maxTokens 8192) widened extract further. A timeout
    // that kills writers mid-write is more dangerous than a longer bound.
    ? Math.max(intervalDerivedTimeoutMs, 3_600_000)
    : intervalDerivedTimeoutMs;
}
