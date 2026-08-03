---
name: tigerstyle
description: Applies TigerStyle engineering discipline with Safety > Performance > Developer Experience, including TypeScript and JavaScript runtime validation, async ownership, bounded resources, and predictable execution. Use when writing, refactoring, designing, reviewing, or checking reliable code.
metadata:
  source: "https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md"
---

# TigerStyle


Apply priorities in this order:

1. **Safety**: correctness, data integrity, bounded behavior, and explicit failure handling.
2. **Performance**: predictable resource use, latency, and throughput.
3. **Developer Experience**: code that communicates the system's model precisely.

When priorities conflict, the earlier priority wins. Seek the design that improves all three rather than trading one away prematurely.

## Modes

- With no argument, apply TigerStyle while designing, writing, or modifying code. Do not produce a style report unless useful to the task.
- `analyze <path>` is read-only. Report aligned patterns, violations, and gray areas. Ask for the path if it is missing.
- `check [path]` is read-only. Report violations only, highest severity first. Check the supplied path, or the current scoped diff when no path is supplied. If neither scope is clear, ask for a path.


Never edit in `analyze` or `check` mode unless the user subsequently asks for fixes.

## Review discipline

- Review only the supplied path or an explicitly requested diff. Do not silently expand a file review into a repository audit.
- If a requested path is missing or ambiguous, ask instead of choosing the nearest file.
- Report one finding per root cause. Collapse duplicate symptoms and omit hypothetical or preference-only concerns.
- A missing limit is a violation only when externally controlled work can grow without a domain bound and the consequence is plausible. Do not invent a numeric budget.
- If evidence is insufficient, omit the issue from `check`; mention it only as a gray area in `analyze`.

## Before code

Understand the relevant flow end to end. Identify:

- trust, serialization, and persistence boundaries;
- invariants, preconditions, postconditions, and state transitions;
- ownership, lifetime, cancellation, and cleanup;
- expected operational errors versus programmer errors;
- work or storage that can grow: inputs, loops, recursion, queues, retries, concurrency, memory, and time;
- network, disk, memory, and CPU costs, considering both latency and bandwidth.

Use concrete budgets from the domain. If a limit is unknown and matters for safety or predictable performance, surface that design gap instead of inventing a number. Do not report a missing number by itself; show the externally controlled growth and plausible consequence.

## Safety

- Prefer simple, explicit control flow and few excellent abstractions. Every abstraction must clarify the domain enough to pay for its failure modes and indirection.
- State invariants positively. Split compound conditions when independent cases matter, and handle or assert the negative space instead of adding empty branches.
- Bound work and resource growth. Finite iteration over already-bounded data needs no duplicate counter; externally controlled data must be limited at its boundary.
- Avoid recursion unless maximum depth is proven safe. Use explicit iteration when depth can be adversarial or operationally unbounded.
- Assert programmer-controlled invariants and impossible states. Handle invalid external input and expected operational failures as errors, not assertions.
- An invariant failure must not be caught and treated as recoverable continuation. Use an assertion mechanism active wherever that invariant protects correctness.
- Assert meaningful preconditions, postconditions, and state relationships. Split independent assertions for precise failures; never add assertions to satisfy a quota.
- Pair critical checks across distinct boundaries when possible, such as before persistence and after loading. Check both valid and invalid state space.
- Revalidate mutable assumptions after `await`, `yield`, callbacks, or any other suspension point.
- Handle every error intentionally. Propagate, transform, retry within a bound, or terminate. Never discard an error silently.
- Keep mutable state singular and ownership clear. Avoid aliases or duplicated variables that can diverge.
- Keep values in the smallest useful scope and compute or validate them close to use.
- Keep functions inspectable as one coherent unit. Treat roughly 70 lines as a review signal, not permission for mechanical fragmentation. Push branching upward and non-branching work into focused leaf functions.
- Do not expose stale, uninitialized, or cross-request data through partially used buffers, padding, pooling, or serialization.
- Treat all compiler warnings and relevant static-analysis findings as work to resolve, not background noise.
- Do not knowingly ship correctness, safety, data-loss, or unbounded-complexity debt. Remove scope before deferring a known critical defect.
- Verify positive and negative paths: malformed input, boundaries, state transitions, partial failure, recovery, cancellation, and cleanup.

## Performance

- Consider performance in the design, when structural gains are still available. Write a back-of-the-envelope model when scale or latency matters.
- Optimize resources in context, generally network, disk, memory, then CPU, adjusted for access frequency.
- Batch operations when amortization improves predictability without violating latency or correctness requirements.
- Separate control-plane validation and coordination from regular data-plane work when that makes the hot path simpler and more predictable.
- Keep hot work explicit and regular. Extract or specialize hot loops only when a model or measurement justifies it.
- Control reactions to external events with bounded work, backpressure, coalescing, or batching. Long-lived event loops need explicit lifetime, cancellation, and cleanup rather than a fake iteration bound.
- State what was measured or estimated. Do not present speculative micro-optimizations as facts.

## Developer Experience

- Choose precise nouns and verbs. Avoid abbreviations unless they are established domain language.
- Include units and qualifiers in names, ordered consistently, such as `latency_ms_max` or the target language's equivalent.
- Distinguish indexes, counts, sizes, offsets, durations, and identifiers in names and types. Make rounding and overflow intent explicit.
- Prefer simpler signatures, return values, and state transitions. Complexity at a boundary spreads through every caller.
- Use named parameters or an options object when adjacent same-typed arguments can be confused.
- Put important public flow near the top and details below. Order related declarations consistently.
- Comments explain why, constraints, and surprising invariants. Do not narrate obvious code.
- Put durable design rationale in descriptive commit messages when creating commits.
- Pass options explicitly when a library default affects correctness, durability, security, or performance.
- Follow the target project's formatter and language conventions. TigerStyle is a design discipline, not Zig syntax transplanted everywhere.
- Prefer the language runtime, standard library, and existing project dependencies. Add a dependency only when its correctness and maintenance value exceed its supply-chain and operational cost.

## Adaptation guardrails

Do not transplant these Zig/TigerBeetle policies literally into every environment:

- static allocation after initialization;
- fixed-width integer syntax;
- a fixed assertion count per function;
- mandatory `else` branches;
- one naming or indentation convention;
- hard line, function, or dependency counts.

Preserve the underlying goals: bounded resources, explicit contracts, exhaustive reasoning, predictable execution, clear names, and minimal operational surface.

## Review output

Report only evidence-backed findings. Reply in the user's natural language. Categories are `Safety`, `Performance`, and `DX`.

```text
SEVERITY | CATEGORY | path:line | rule | evidence | smallest remediation
```

- **CRITICAL**: evidence shows a plausible path to corruption, data loss, security failure, process/resource exhaustion, or broken recovery. Do not use it for a merely technical absence of a cap, missing optional tooling, or speculative impact.
- **MAJOR**: evidence shows a realistic incorrect or unpredictable behavior caused by missing bounds, error handling, invariants, or an important contract.
- **MINOR**: evidence shows naming, locality, comments, or consistency that slows verification without an immediate correctness risk.

For `analyze`, add short `Aligned` and `Gray areas` sections. State uncertainty and checks not run. Do not inflate severity or report style preferences as safety defects. For a clean `check`, say `No violations found`; do not invent findings.

## Sources

Derived from [TigerBeetle's TigerStyle](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md). The language-specific overlay pattern was informed by [M64GitHub/tiger-style](https://github.com/M64GitHub/tiger-style).
