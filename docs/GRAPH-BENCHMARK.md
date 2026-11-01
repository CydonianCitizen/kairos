# Local graph indexing measurements

Measured on 2026-11-01 at 00:30 UTC, using Node v24.21.0 on Windows 10.0.26300,
Intel Core i5-10500H 2.50 GHz. No NIM or other network requests were made.

Run after building the checkout:

```sh
npm run build
node tests/fixtures/graph-benchmark.mjs
```

The fixture runs in one process. The first repository index includes WASM grammar
initialization; later measurements reuse the existing grammar cache. Each index
still enumerates files, reads ignore rules and sources, parses all eligible files,
and rebuilds dependency edges. OS filesystem caching and JavaScript/WASM warmup
affect later measurements. These are elapsed times from one run, not performance
guarantees or isolated parser timings.

| Workspace and operation | Elapsed milliseconds | Files | Symbols |
| --- | ---: | ---: | ---: |
| Actual checkout, first index, grammar cold | 839.0 | 82 | 552 |
| Actual checkout, unchanged repeat 1 | 798.3 | 82 | 552 |
| Actual checkout, unchanged repeat 2 | 510.3 | 82 | 552 |
| Actual checkout, unchanged repeat 3 | 468.6 | 82 | 552 |
| Actual checkout, one TypeScript file added | 446.7 | 83 | 553 |
| Synthetic workspace, first index, grammar warm | 1563.6 | 500 | 5000 |
| Synthetic workspace, unchanged repeat 1 | 1430.8 | 500 | 5000 |
| Synthetic workspace, unchanged repeat 2 | 1119.5 | 500 | 5000 |
| Synthetic workspace, unchanged repeat 3 | 1009.5 | 500 | 5000 |
| Synthetic workspace, one function body changed | 932.9 | 500 | 5000 |

The synthetic workspace contains 500 TypeScript files, ten exported functions per
file, imports from the preceding file, and local calls. It produced 10,498 graph
edges and no parse diagnostics. This exercises imports and symbol extraction but
does not represent every language, very large source files, or a large monorepo.

The actual checkout was being edited by other agents during measurement. The
recorded snapshot had one parse diagnostic; a subsequent diagnostic-only scan
reported `tests/atomic-edits.test.ts` and `tests/undo.test.ts`, both with the existing
generic parser warning about potentially incomplete extracted symbols. The source
of those warnings was not changed as part of this work. Concurrent work and warmup
make small differences between the rows inconclusive; the one-file rows do not
demonstrate an incremental optimization.

## Decision

Retain full graph rebuilds and the existing in-memory grammar cache. Warm indexing
was around half a second for the actual checkout and around one second for this
500-file synthetic workspace. These measurements do not establish a material
bottleneck that justifies parsed-record caching and its invalidation rules yet.
No parsed-file cache, persistent database, watcher, or indexer behavior change was
introduced. Full rebuilds continue to pick up changed/deleted files, imports and
ignore rules without cache invalidation concerns.

Revisit if representative workspaces show indexing repeatedly delaying interactive
turns. Measure several runs in an otherwise idle checkout before implementing a
cache; then prove addition, deletion, imports, ignore changes and cancellation
before comparing timings.

## Explicit reference context

`resolveReferences()` uses the current graph snapshot for symbol content instead
of re-reading the whole source file. Direct file references read at most 1 MiB per
file. Its complete emitted context, including labels and truncation notices, is
capped at 12,000 JavaScript string characters by default; callers can choose a
smaller cap from 256 characters. The result reports actual context characters,
the chosen cap and per-reference source characters/truncation. Every call resolves
only references in its current prompt.

Shorthand code paths must be indexed; `@file:path` is an explicit selection that
can override an ignore rule. All forms still reject traversal, external symlinks,
recognized credential/key filenames and private-key contents. Symbol locations
and sources describe the graph snapshot; the host refreshes that snapshot before
resolving a new turn.
