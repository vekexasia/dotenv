---
name: tigerstyle-typescript
description: Applies a TypeScript and JavaScript TigerStyle overlay for runtime validation, strict types, async ownership, bounded concurrency, cleanup, exact numbers, and predictable Node or browser performance. Use with tigerstyle whenever writing, refactoring, reviewing, or checking TypeScript or JavaScript.
metadata:
  source: "https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md"
---

# TigerStyle for TypeScript and JavaScript

Read `../tigerstyle/SKILL.md` first when it is not already loaded; this file is an overlay, not a replacement. If the generic skill is unavailable, preserve Safety > Performance > Developer Experience. Do not load either skill recursively.

Inherit its modes and review format. With no argument, apply the rules during normal implementation. `analyze` and `check` remain read-only.

## Establish the environment

Before choosing a pattern:

- Read the relevant `tsconfig`, package manifest, lockfile, formatter, linter, and test configuration.
- Identify the runtime and target versions: Node.js, browser, Deno, Bun, workers, or a combination.
- Reuse existing validation, assertion, result, cancellation, logging, and test patterns. Do not add a library or change project configuration unless the task requires it.

## Runtime boundaries

TypeScript types disappear at runtime. Treat JSON, parsed files, environment variables, storage, database rows, CLI arguments, URL parameters, `postMessage`, IPC, and network responses as untrusted until validated.

- Receive uncertain data as `unknown`, not `any` or a claimed domain type. Assign `JSON.parse` results to an explicitly typed `unknown` immediately.
- Narrow with the project's existing schema validator, parser, or type guards before use.
- Limit bytes before parsing where possible, then limit nesting depth during validation. Avoid recursive validation for adversarial depth.
- Validate domain invariants before serialization or persistence and again after parsing, loading, or recovery.
- Reject dangerous dynamic keys such as `__proto__`, `constructor`, and `prototype` before merging untrusted objects. Prefer `Map` or null-prototype objects for arbitrary keys.
- Avoid unchecked `as` casts and non-null assertions. If one is unavoidable at a verified boundary, keep it local and state the invariant that proves it safe.
- Remember that `satisfies` checks compile-time shape but performs no runtime validation.

Use assertions for programmer errors and impossible states. Return or throw an operational error for malformed user, file, or network input. Prefer the repository's existing invariant mechanism; when it narrows a type, verify its signature uses `asserts`. Use `node:assert/strict` only in Node code where that runtime dependency is appropriate.

## Type model

- Prefer discriminated unions for state machines and exhaustively handle variants with a `never` check or the project's equivalent.
- Make invalid states unrepresentable where this simplifies runtime reasoning, but do not hide validation behind speculative type machinery.
- Use `readonly` to communicate ownership. Remember that TypeScript's `readonly` and `Readonly<T>` are shallow compile-time restrictions, not runtime immutability.
- Use distinct domain types or light brands when they prevent plausible confusion between identifiers, indexes, counts, bytes, or durations. Do not brand every primitive.
- Keep optionality explicit. Do not use `undefined`, absent properties, and `null` interchangeably without a domain reason.

Recommend strict compiler checks when reviewing a new configuration or when type-safety is explicitly in scope, including `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, and `noImplicitReturns`. In an existing project, their absence is a migration note, not a violation by itself. Do not silently enable them: report migration impact or make the requested local fix.

## Numbers and binary data

JavaScript has no general fixed-width integer scalar types.

- Validate finite, integer, sign, and range assumptions at boundaries. For text, validate the complete lexical form before conversion instead of relying on coercive `Number` or permissive `parseInt`.
- Use `Number.isSafeInteger` when exact integer representation matters.
- Use `bigint` for exact integers outside the safe `number` range. Convert explicitly and never mix `bigint` with `number` arithmetic. Standard JSON cannot encode `bigint`; define a string-based wire representation when needed.
- Represent exact decimal domains with scaled integers, `bigint`, or an existing decimal library according to the domain's range and rounding rules.
- Name units in the project's casing, such as `timeoutMs`, `payloadBytes`, or `latencyMsMax`.
- Distinguish index, count, length, byte size, and offset. Make rounding behavior explicit with the appropriate `Math` operation and test boundary values.
- Use `Uint8Array` and `DataView` for binary formats, with explicit bounds and endianness. Remember that transferring an `ArrayBuffer` detaches it from the sender.
- For `number`, bitwise operators coerce operands to 32-bit integers; `>>>` returns an unsigned 32-bit result. `bigint` bitwise operations have different arbitrary-precision semantics.

## Async ownership and cancellation

Every promise must have an owner and a rejection path.

- Await or return promises. Fire-and-forget work must have an explicit lifetime and observable rejection handling, for example `void task().catch(reportError)` when that matches project policy.
- Bound request duration, retries, pagination, queue capacity, fan-out, worker count, and concurrency where external demand can grow them.
- Use `AbortSignal` for operations that support cancellation. Check an already-aborted signal before starting; a timeout without cancellation does not stop underlying work.
- Pass cancellation through call chains. Register one-shot abort listeners or remove them during cleanup.
- Do not hold a transaction, lock, or assumed mutable-state invariant across `await` without rechecking it after resumption.
- Make state transitions atomic from the observer's perspective, or define rollback for partial failure and cancellation.
- Long-lived subscriptions, streams, timers, sockets, workers, and event listeners require explicit ownership and disposal.
- Use `try/finally` for cleanup. Use `using` or `await using` only when the configured target and runtime support explicit resource management.

`Promise.all` does not limit concurrency or cancel sibling work after one promise rejects. Bound work before aggregation. Use `Promise.allSettled` when every result matters, or shared cancellation when fail-fast behavior must stop siblings.

## Errors

- Catch as `unknown` and narrow before reading properties.
- Preserve the original error with `cause` when wrapping adds useful context and the target runtime supports it.
- Distinguish expected domain or operational failures from invariant failures. Use the project's established exception or result convention rather than introducing a second error system.
- Never leave an empty `catch`, a floating rejected promise, or an ignored callback error. A deliberate best-effort fallback must be documented and observable when failure matters operationally.
- Cancellation is not a transient failure. Retry only classified transient failures, with a fixed attempt or deadline budget. Consider idempotency and duplicate effects; use backoff and jitter when clients can synchronize.

## Memory, queues, and backpressure

Garbage collection and dynamic allocation are normal in JavaScript runtimes. Do not emulate Zig allocators or require static allocation.

- Bound request bodies, parsed documents, caches, queues, retained history, and other externally driven storage.
- Give queues both a capacity and an overflow policy. Bound queue length separately from consumer concurrency.
- Use stream backpressure instead of buffering entire inputs when streaming matches the API.
- Release accidental retention through globals, closures, event listeners, timers, unresolved promises, object URLs, and caches.
- Clear reused mutable buffers that can expose secrets or data across requests. Treat clearing as best effort; immutable strings cannot be reliably scrubbed.
- Avoid custom pools and buffer reuse until measurement shows allocation or GC pressure is material.

## Performance by runtime

- On servers, watch event-loop delay, synchronous I/O, unbounded microtask chains, thread-pool saturation, N+1 calls, and memory retained per request.
- In browsers, watch main-thread tasks, layout and paint churn, detached DOM, network waterfalls, bundle cost, and worker transfer or copy costs.
- Batch network, storage, IPC, DOM, and worker operations when the latency and failure semantics remain correct.
- Prefer built-in platform APIs and already-installed dependencies. Judge a new dependency by correctness, maintenance, bundle/install cost, provenance, and lockfile impact rather than imposing zero dependencies.
- Profile before rewriting idiomatic collection operations. Replace `Array.shift()` with an indexed queue or ring buffer only when queue scale or hot-path evidence justifies it.

## TypeScript adaptation guardrails

Do not require:

- `snake_case`, four-space indentation, or a fixed column width over project tooling;
- two assertions in every function;
- an `else` for every `if`;
- static allocation, allocator threading, or object pools;
- `Uint32Array` merely to imitate a `u32` domain value;
- helper functions that fragment clear code only to satisfy a line count;
- bespoke wrappers around standard `Promise`, `AbortSignal`, streams, or error features.

Preserve TigerStyle's intent instead: explicit contracts, exhaustive state handling, bounded external work, visible async ownership, safe runtime validation, predictable resources, and precise names.

## Verification

Run existing repository type-check, relevant tests, and lint commands when they exist and are in scope. A missing command is a check not run, not a violation by itself, unless the task explicitly reviews the tooling or package contract. A transpiler or test runner may execute TypeScript without type-checking it.

For changed behavior, cover the smallest relevant set of:

- valid and malformed runtime input;
- missing, extra, oversized, and deeply nested data;
- numeric boundaries and unsafe integers;
- all discriminated-union states;
- rejection, timeout, abort, retry exhaustion, and partial failure;
- ordering, backpressure, queue overflow, and concurrency limits;
- cleanup of listeners, timers, streams, handles, and retained state.

Prefer deterministic clocks or the existing fake-timer support over sleeps. Use property or fuzz testing for parsers, protocols, and state machines only when their risk justifies it and project tooling supports it.

## Sources

Derived from [TigerBeetle's TigerStyle](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md). The language-overlay structure was informed by [M64GitHub/tiger-style](https://github.com/M64GitHub/tiger-style).
