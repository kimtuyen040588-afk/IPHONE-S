import assert from 'node:assert/strict';
import test from 'node:test';

import { validateAssessment } from '../src/agent/planner.js';

test('planner accepts only the constrained readiness response', () => {
    assert.deepEqual(validateAssessment({ readiness: 'ready', note: 'Messages is visible' }), {
        readiness: 'ready', note: 'Messages is visible',
    });
    assert.throws(() => validateAssessment({ readiness: 'send-now', note: 'go' }), /invalid readiness/);
    assert.throws(() => validateAssessment({ readiness: 'ready', note: 'two\nlines' }), /invalid note/);
    assert.throws(() => validateAssessment({ readiness: 'ready', note: 'x'.repeat(281) }), /invalid note/);
});
