/**
 * The persona runner — one test per sandboxed user profile.
 *
 * Each persona module exports { id, description, run, teardown }. The suite
 * imports them in value order (highest-value first: the first-contact
 * persona leads), gives potato its per-test headroom, and turns any failure
 * into a named, persona-scoped red. A red here = a real defect discovered by
 * a persona, per the task's iron rules — fix and pin, never delete the test.
 */

import { test } from 'playwright/test';
import * as grandma from './personas/grandma-first-boot';
import * as corrupted from './personas/corrupted-state';
import * as hoarder from './personas/mod-hoarder';
import * as flaky from './personas/flaky-network';
import * as potato from './personas/potato-pc';

const personas = [grandma, corrupted, hoarder, flaky, potato];

for (const persona of personas) {
  test(`persona: ${persona.id} — ${persona.description.slice(0, 24)}…`, async () => {
    try {
      await persona.run();
    } finally {
      await persona.teardown();
    }
  });
}
