# ArchSieve snapshot model (0.1)

- `subject`: repo name, commit (`null` outside git), `dirty` (uncommitted changes in scope).
- `tools` / `analyses`: exact tool versions, what ran, what was skipped and why.
- `nodes[].kind`: `file`, `vendored-file` (boundary, not followed), `external-package`, `go-package`, `nest-module`, `nest-provider`, `nest-controller`.
- `edges[].kind`: `imports` (static; `typeOnly: true` when erased at runtime), `nest-imports`, `nest-injects`.
- Every node and edge has `evidence[]`: which tool reported it and, when the tool reports one, the file and import specifier.
- `findings[].level`:
  - `error`: verifiable from the evidence (runtime import cycle, DI cycle, Go cycle).
  - `signal`: heuristic (orphan file, type-only cycle, token indirection with one binding).
  - `unknown`: not inferable (unresolved import, factory/value provider, Go package load error).
- `limitations`: what the analyzers cannot see (runtime calls, IPC, queues, computed imports, Rust).

Schemas: `schema/snapshot.schema.json`, `schema/diff.schema.json` (JSON Schema 2020-12).
