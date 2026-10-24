import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { startInfinitepayProcessing } from '../../src/infinitepayRuntime.js';

test('financial worker runs one batch at a time and stop awaits the active batch', async () => {
    let calls = 0, release, entered;
    const active = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const worker = startInfinitepayProcessing({ async processPending() { calls++; entered(); await active; } }, { intervalMs: 10 });
    await started; await pause(40); assert.equal(calls, 1);
    let stopped = false; const stopping = worker.stop().then(() => { stopped = true; });
    await pause(20); assert.equal(stopped, false);
    release(); await stopping; await pause(30); assert.equal(calls, 1);
});
test('financial worker retries a failed batch without exposing or propagating raw provider errors', async () => {
    let calls = 0, done;
    const next = new Promise(resolve => { done = resolve; });
    const worker = startInfinitepayProcessing({ async processPending() { if (++calls === 1) throw new Error('SYNTHETIC_WORKER_SECRET'); done(); } }, { intervalMs: 10 });
    await next; await worker.stop(); assert.ok(calls >= 2);
});
for (const intervalMs of [0, 1, -1, 1.5, '1000']) test('financial worker rejects invalid interval ' + intervalMs, () => {
    assert.throws(() => startInfinitepayProcessing({ processPending() {} }, { intervalMs }), TypeError);
});
