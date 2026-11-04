# Circuit Breaker Proof Slice (PromptPilot)

PromptPilot drafts support replies by calling an external model provider. This slice adds one control: a circuit breaker that stops calling the provider during sustained failure, serves a safe fallback, and recovers through a probe.

## Risk addressed

When the provider is failing, every request still tries it, so doomed calls pile up and the failure spreads to the whole reply path.

## Chosen control

A circuit breaker in `src/circuitBreaker.js`, wrapping the provider call in `src/replyService.js`. It opens at a 50% failure rate over at least 5 calls, refuses calls for 30 seconds, then allows one probe. While it is open, the customer gets "Your ticket is queued for a human agent."

## How to run / test

Needs Node.js 18 or newer, and nothing to install.

```bash
node --test
```

Expected result: 16 tests pass and 0 fail (the 8 supplied tests, plus 8 in `test/hardening.test.js`).

## Evidence

The test `the provider is not called while open, and it recovers through a probe` makes 105 requests during an outage. The provider is called only 5 times, the other 100 get the fallback with `short_circuited_total` at 100, and the next request after the window closes the breaker. The supplied tests prove the trip, short-circuit, probe, and re-open rules.

## Observability note

`breaker_open_total` moves on every trip, and `short_circuited_total` on every refused call. Every state change logs one JSON line, with no ticket or provider error text:

```json
{"event":"breaker_state_change","component":"model_provider","state":"OPEN","breaker_open_total":1,"short_circuited_total":0}
```

## Trade-off

During the open window, customers get the fallback even if the provider has already recovered, so they can wait up to 30 seconds longer for a model draft, and more tickets go to human agents.

## Remaining risk

The breaker only counts failures, so a provider that hangs without failing never trips it, and a hung probe would keep it in `HALF_OPEN`. Counts are not time-windowed, so a long healthy run delays a trip, and each process has its own breaker. Next, I would add a per-call timeout, then a rolling window.

## How this production control protects my Modules 1-3 design

It protects the Module 3 decision that the model only suggests and a fallback keeps the workflow alive when the model fails. It also protects the Module 1 promise that a support request always gets a timely answer, because a failing provider now gets a fast fallback instead of holding up the reply path.
