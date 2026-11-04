// Added with the implementation. These cover cases the supplied tests do not.
const { test } = require('node:test');
const assert = require('node:assert');
const { createCircuitBreaker, CircuitOpenError } = require('../src/circuitBreaker');
const { createReplyService } = require('../src/replyService');

const fail = () => Promise.reject(new Error('provider down'));
const ok = () => Promise.resolve('drafted');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function trip(cb) {
  for (let i = 0; i < 5; i++) await cb.exec(fail).catch(() => {});
  assert.equal(cb.state, 'OPEN');
}

test('stays closed when the failure ratio is below the threshold', async () => {
  const cb = createCircuitBreaker({ failureThreshold: 0.5, minimumRequests: 5 });
  for (let i = 0; i < 3; i++) await cb.exec(ok);
  for (let i = 0; i < 2; i++) await cb.exec(fail).catch(() => {});
  assert.equal(cb.state, 'CLOSED');
});

test('keeps refusing until the open window has fully elapsed', async () => {
  let clock = 0;
  const cb = createCircuitBreaker({ openMillis: 1000, now: () => clock });
  await trip(cb);
  clock = 999;
  await assert.rejects(() => cb.exec(ok), CircuitOpenError);
  assert.equal(cb.state, 'OPEN');
});

test('allows only one probe, and refuses other calls while it runs', async () => {
  let clock = 0;
  const cb = createCircuitBreaker({ openMillis: 1000, now: () => clock });
  await trip(cb);
  clock = 1000;
  const probe = deferred();
  const first = cb.exec(() => probe.promise);
  let secondCalled = false;
  await assert.rejects(() => cb.exec(async () => { secondCalled = true; }), CircuitOpenError);
  assert.equal(secondCalled, false);
  assert.equal(cb.state, 'HALF_OPEN');
  probe.resolve('drafted');
  assert.equal(await first, 'drafted');
  assert.equal(cb.state, 'CLOSED');
});

test('a slow call from before the trip cannot trip the breaker again', async () => {
  const cb = createCircuitBreaker({ openMillis: 1000, now: () => 0 });
  const slow = deferred();
  const slowCall = cb.exec(() => slow.promise).catch(() => {});
  await trip(cb);
  slow.reject(new Error('provider down'));
  await slowCall;
  assert.equal(cb.metrics.breaker_open_total, 1);
  assert.equal(cb.metrics.failure_total, 6);
});

test('counts reset after recovery, so one new failure does not re-open', async () => {
  let clock = 0;
  const cb = createCircuitBreaker({ openMillis: 1000, now: () => clock });
  await trip(cb);
  clock = 1000;
  await cb.exec(ok);
  await cb.exec(fail).catch(() => {});
  assert.equal(cb.state, 'CLOSED');
});

test('a broken state-change observer does not break the call', async () => {
  const cb = createCircuitBreaker({ minimumRequests: 1, onStateChange() { throw new Error('observer'); } });
  await assert.rejects(() => cb.exec(fail), /provider down/);
  assert.equal(cb.state, 'OPEN');
});

test('the provider is not called while open, and it recovers through a probe', async () => {
  let clock = 0;
  let healthy = false;
  let providerCalls = 0;
  const provider = () => { providerCalls += 1; return healthy ? ok() : fail(); };
  const svc = createReplyService(provider, { openMillis: 1000, now: () => clock, log() {} });
  for (let i = 0; i < 5; i++) await svc.draftReply({ id: i });
  for (let i = 0; i < 100; i++) await svc.draftReply({ id: i });
  assert.equal(providerCalls, 5);
  assert.equal(svc.breaker.metrics.short_circuited_total, 100);
  healthy = true;
  clock = 1000;
  assert.equal((await svc.draftReply({ id: 200 })).source, 'model');
  assert.equal(svc.breaker.state, 'CLOSED');
});

test('logs each state change as JSON with no ticket or provider error data', async () => {
  const lines = [];
  const provider = () => Promise.reject(new Error('sk-secret-token'));
  const svc = createReplyService(provider, { now: () => 0, log: (l) => lines.push(l) });
  for (let i = 0; i < 5; i++) await svc.draftReply({ id: i, customerEmail: 'person@example.com' });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    event: 'breaker_state_change',
    component: 'model_provider',
    state: 'OPEN',
    breaker_open_total: 1,
    short_circuited_total: 0,
  });
  assert.ok(!lines[0].includes('person@example.com'));
  assert.ok(!lines[0].includes('sk-secret-token'));
});
