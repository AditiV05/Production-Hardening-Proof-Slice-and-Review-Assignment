'use strict';

// Circuit breaker around PromptPilot's model provider.
//
// CLOSED:    calls run, and calls and failures are counted.
// OPEN:      calls are refused with CircuitOpenError, without touching the provider.
// HALF_OPEN: after openMillis, one probe runs. Success closes, failure re-opens.

class CircuitOpenError extends Error {
  constructor() {
    super('circuit is open');
    this.code = 'CIRCUIT_OPEN';
  }
}

function createCircuitBreaker(options = {}) {
  const failureThreshold = options.failureThreshold ?? 0.5;
  const minimumRequests = options.minimumRequests ?? 5;
  const openMillis = options.openMillis ?? 30000;
  const now = options.now ?? Date.now;
  const onStateChange = options.onStateChange ?? function () {};

  const metrics = {
    breaker_open_total: 0,
    short_circuited_total: 0,
    success_total: 0,
    failure_total: 0,
  };

  let state = 'CLOSED';
  let calls = 0;
  let failures = 0;
  let openedAt = 0;
  let probeInFlight = false;
  // Changes on every transition, so a slow call that started under an earlier
  // state cannot affect the current one when it finally finishes.
  let generation = 0;

  function transition(next) {
    state = next;
    generation += 1;
    if (next === 'OPEN') {
      openedAt = now();
      metrics.breaker_open_total += 1;
    }
    try {
      onStateChange(next);
    } catch {
      // A broken observer must not change the outcome of the protected call.
    }
  }

  function shortCircuit() {
    metrics.short_circuited_total += 1;
    throw new CircuitOpenError();
  }

  async function exec(fn) {
    if (state === 'OPEN') {
      if (now() - openedAt < openMillis) shortCircuit();
      transition('HALF_OPEN');
    }

    const isProbe = state === 'HALF_OPEN';
    if (isProbe) {
      if (probeInFlight) shortCircuit(); // Only one probe at a time.
      probeInFlight = true;
    }

    const startedIn = generation;
    try {
      const result = await fn();
      metrics.success_total += 1;
      if (isProbe) {
        probeInFlight = false;
        calls = 0;
        failures = 0;
        transition('CLOSED');
      } else if (startedIn === generation) {
        calls += 1;
      }
      return result;
    } catch (err) {
      metrics.failure_total += 1;
      if (isProbe) {
        probeInFlight = false;
        transition('OPEN');
      } else if (startedIn === generation) {
        calls += 1;
        failures += 1;
        if (calls >= minimumRequests && failures / calls >= failureThreshold) {
          transition('OPEN');
        }
      }
      throw err;
    }
  }

  return {
    exec,
    metrics,
    get state() {
      return state;
    },
  };
}

module.exports = { createCircuitBreaker, CircuitOpenError };
