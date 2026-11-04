'use strict';

// Connects the circuit breaker to a real risk: PromptPilot drafts a support
// reply by calling an external model provider. When the provider is failing,
// the breaker short-circuits and the service degrades safely instead of
// piling up doomed calls.

const { createCircuitBreaker, CircuitOpenError } = require('./circuitBreaker');

const FALLBACK_TEXT = 'Your ticket is queued for a human agent.';

function createReplyService(callProvider, options = {}) {
  const log = options.log ?? console.log;
  const breaker = createCircuitBreaker({
    ...options,
    onStateChange(state) {
      // Safe metadata only: never the ticket, the prompt, or the provider error text.
      log(JSON.stringify({
        event: 'breaker_state_change',
        component: 'model_provider',
        state,
        breaker_open_total: breaker.metrics.breaker_open_total,
        short_circuited_total: breaker.metrics.short_circuited_total,
      }));
      options.onStateChange?.(state);
    },
  });

  async function draftReply(ticket) {
    try {
      const text = await breaker.exec(() => callProvider(ticket));
      return { source: 'model', text };
    } catch (err) {
      // Whether the breaker short-circuited (CircuitOpenError) or the provider
      // itself failed, the critical path stays alive with a safe fallback.
      if (err instanceof CircuitOpenError) {
        return { source: 'fallback', text: FALLBACK_TEXT, reason: 'circuit_open' };
      }
      return { source: 'fallback', text: FALLBACK_TEXT, reason: 'provider_error' };
    }
  }

  return { draftReply, breaker };
}

module.exports = { createReplyService, FALLBACK_TEXT };
