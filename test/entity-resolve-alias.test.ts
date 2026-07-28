// S391 — declared-alias arm in entity slug resolution.
//
// Why: `stub_guard_24h` fired repeatedly on entity names that no existing arm
// could resolve. An entity whose spoken name shares no trigram neighbourhood
// with its slug (a rename, a short handle, a page that moved directory) fell
// straight through exact-slug → prefix-expansion → fuzzy to slugify(), minting
// a phantom every single time. The proposed alternative was to hardcode the
// specific offending slugs here; that would bake one brain's private entity
// names into shared source and fix only the instances someone noticed.
//
// The alias arm is the general form: a page declares what people call it, and
// resolution honours that.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveEntitySlug, resolveEntitySlugWithSource } from '../src/core/entities/resolve.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seed(slug: string, aliases?: unknown) {
  await engine.putPage(
    slug,
    {
      type: 'note' as never,
      title: slug,
      compiled_truth: 'x'.repeat(60),
      timeline: '',
      frontmatter: aliases === undefined ? {} : { aliases },
    },
    { sourceId: 'default' },
  );
}

describe('S391 — alias resolution', () => {
  test('an alias resolves to its canonical slug instead of minting a phantom', async () => {
    await seed('projects/widget-co', ['Widget Co', 'widget-co-legacy']);
    expect(await resolveEntitySlug(engine, 'default', 'Widget Co')).toBe('projects/widget-co');
  });

  test('alias matching is case- and whitespace-insensitive', async () => {
    await seed('projects/widget-co', ['  Widget CO  ']);
    expect(await resolveEntitySlug(engine, 'default', 'widget co')).toBe('projects/widget-co');
  });

  test('a slugified spelling of the alias also resolves', async () => {
    await seed('projects/widget-co', ['Widget Co']);
    expect(await resolveEntitySlug(engine, 'default', 'Widget-Co')).toBe('projects/widget-co');
  });

  test('an exact slug still wins over an alias claiming the same text', async () => {
    await seed('people/alice-example', ['people/bob-example']); // mischievous alias
    await seed('people/bob-example');
    expect(await resolveEntitySlug(engine, 'default', 'people/bob-example')).toBe('people/bob-example');
  });

  test('an AMBIGUOUS alias resolves to neither page', async () => {
    // Two pages claiming the same name must not silently misattribute.
    // Uses a multi-word alias deliberately: a single bare token would be
    // rescued downstream by prefix expansion (`companies/acme-*`), which is
    // correct existing behaviour and would mask what this test is pinning.
    await seed('projects/widget-co', ['Acme Holdings']);
    await seed('companies/acme-example', ['Acme Holdings']);
    const got = await resolveEntitySlug(engine, 'default', 'Acme Holdings');
    expect(got).toBe('acme-holdings'); // fallback slugify, not a guess between the two
  });

  test('a non-array aliases field is ignored rather than crashing', async () => {
    await seed('projects/widget-co', 'Widget Co'); // string, not array
    expect(await resolveEntitySlug(engine, 'default', 'Widget Co')).toBe('widget-co');
  });

  test('alias resolution is reported as exact_page, not fuzzy', async () => {
    await seed('projects/widget-co', ['Widget Co']);
    const r = await resolveEntitySlugWithSource(engine, 'default', 'Widget Co');
    expect(r?.slug).toBe('projects/widget-co');
    expect(r?.source).toBe('exact_page');
  });

  test('unrelated input is untouched by the new arm', async () => {
    await seed('projects/widget-co', ['Widget Co']);
    expect(await resolveEntitySlug(engine, 'default', 'something-else-entirely'))
      .toBe('something-else-entirely');
  });
});
