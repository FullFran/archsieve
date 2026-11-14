# ArchSieve snapshot model (0.5)

- `subject`: repo name, commit (`null` outside git), `dirty` (uncommitted changes in scope).
- `tools` / `analyses`: exact tool versions, what ran, what was skipped and why.
- `nodes[].kind`: `file`, `vendored-file` (boundary, not followed), `external-package`, `go-package`, `nest-module`, `nest-provider`, `nest-controller`.
- `nodes[].test`: `true` when the path matches a test glob (globs recorded in `analyses`, tool `test globs`); absent means production. A path convention, not proof.
- `edges[].kind`: `imports` (static; `typeOnly: true` when erased at runtime), `nest-imports`, `nest-injects`, `depends-on` (container to container, from code), `runtime-link` (container to container, a child process or Tauri sidecar started with a literal program, or an HTTP call whose literal path matches one other container's route; relations `child-process` / `sidecar` / `http-route`; `confidence: "pattern"`, evidence with `line`).
- `depends-on` edges: `relations` counts imports and package dependencies between units; `testRelations` is the part that comes from test files.
- With `--model`, nodes and `depends-on` edges get `status`: `confirmed`, `declared-unverified`, `undeclared`, or (links only) `code-dependency-only` (declared as a runtime link, coupled in code, runtime link itself unproven) or `evidenced` (declared child-process, sidecar or HTTP link with a matching call site of that kind: pattern confidence, below `confirmed`). `runtime-call-unresolved` unknowns name call sites whose program is built at runtime.
- `test-only-module` signals: production files imported only by tests (or by each other), grouped by folder with file and line counts; entry points (`package.json` `main`/`module`/`browser`/`bin`/`exports`, `scan --entry-globs`) are never flagged. A file loaded by path at runtime looks the same, so it stays a signal.
- `nodes[].facts` (containers): `files`, `lines`, `languages` (`{files, lines}` per language; lockfiles left out), `manifests` (`file`, `kind`, and `dependencies` / `devDependencies` / `indirect` when counted), `toolchains` (`name`, first `file` implying it). Facts, not a score. `diff` adds `containerFacts` for containers whose facts changed.
- `nodes[].churn` (with `scan --history`): commits touching the file, Go package or container in the window; `co-change-without-link` signals name containers that change together with no static link.
- Every node and edge has `evidence[]`: which tool reported it and, when the tool reports one, the file and import specifier.
- `findings[].level`:
  - `error`: verifiable from the evidence (runtime import cycle, DI cycle, Go cycle).
  - `signal`: heuristic (orphan file, type-only cycle, token indirection with one binding).
  - `unknown`: not inferable (unresolved import, factory/value provider, Go package load error).
- `limitations`: what the analyzers cannot see (runtime calls, IPC, queues, computed imports, Rust).

Schemas: `schema/snapshot.schema.json`, `schema/diff.schema.json` (JSON Schema 2020-12).
