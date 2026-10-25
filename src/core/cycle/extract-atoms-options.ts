// S551: operator-set provider options for extract_atoms chat calls (cycle.extract_atoms.provider_options).

/** S551: `cycle.extract_atoms.provider_options` must be a JSON object of objects (namespace -> options); anything else is ignored with a warning. */
export function parseExtractProviderOptions(raw: string | null | undefined): Record<string, Record<string, unknown>> | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(o => o && typeof o === 'object' && !Array.isArray(o))) {
      return v as Record<string, Record<string, unknown>>;
    }
  } catch { /* fall through */ }
  console.error('[extract_atoms] ignoring cycle.extract_atoms.provider_options: expected a JSON object of objects');
  return undefined;
}
