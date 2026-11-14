# ArchSieve snapshot model (0.4)

- `subject`: repo name, commit (`null` outside git), `dirty` (uncommitted changes in scope).
- `tools` / `analyses`: exact tool versions, what ran, what was skipped and why.
- `nodes[].kind`: `file`, `vendored-file` (boundary, not followed), `external-package`, `go-package`, `nest-module`, `nest-provider`, `nest-controller`.
- `nodes[].test`: `true` when the path matches a test glob (globs recorded in `analyses`, tool `test globs`); absent means production. A path convention, not proof.
- `edges[].kind`: `imports` (static; `typeOnly: true` when erased at runtime), `nest-imports`, `nest-injects`, `depends-on` (container to container, from code), `runtime-link` (container to container, a child process started with a literal program; `confidence: "pattern"`, evidence with `line`).
- `depends-on` edges: `relations` counts imports and package dependencies between units; `testRelations` is the part that comes from test files.
- With `--model`, nodes and `depends-on` edges get `status`: `confirmed`, `declared-unverified`, `undeclared`, or (links only) `code-dependency-only` (declared as a runtime link, coupled in code, runtime link itself unproven) or `evidenced` (declared child-process link with a matching call site: pattern confidence, below `confirmed`). `runtime-call-unresolved` unknowns name call sites whose program is built at runtime.
- `nodes[].churn` (with `scan --history`): commits touching the file, Go package or container in the window; `co-change-without-link` signals name containers that change together with no static link.
- Every node and edge has `evidence[]`: which tool reported it and, when the tool reports one, the file and import specifier.
- `findings[].level`:
  - `error`: verifiable from the evidence (runtime import cycle, DI cycle, Go cycle).
  - `signal`: heuristic (orphan file, type-only cycle, token indirection with one binding).
  - `unknown`: not inferable (unresolved import, factory/value provider, Go package load error).
- `limitations`: what the analyzers cannot see (runtime calls, IPC, queues, computed imports, Rust).

Schemas: `schema/snapshot.schema.json`, `schema/diff.schema.json` (JSON Schema 2020-12).
