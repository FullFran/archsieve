# ADR 0004: Container level (C4 level 2): observed units, a declared model, and the gap between them

Status: accepted · Date: 2026-11-14

## Context

Files and folders (C4 levels 4 and 3) come straight from imports. Containers (C4 level 2: things that run or ship, and how they talk) do not. Static analysis can list the units a repository builds, but it cannot see most links between them: HTTP, IPC, child processes and Tauri commands happen at runtime.

Existing tools split the problem in two:

- Structurizr DSL, LikeC4, C4-PlantUML and Backstage `catalog-info.yaml` are declared by hand and never check the code.
- Nx, Turborepo and `cargo metadata` see packages from code, but not deployables or runtime links.

Among the tools reviewed, none compares a declared container model with what the code shows. The research is in `docs/research/tool-matrix.md`.

## Decision

1. **The core model stays ArchSieve's own, neutral and versioned.** Snapshot schema 0.2 adds `container` nodes and container-level edges. No field is named after a vendor or a tool. Schema 0.1 snapshots remain valid.
2. **Observed units come from manifests only**, which are read as data and never executed:
   - `package.json`;
   - Cargo targets through `cargo metadata --no-deps --offline`, which reads manifests without running build scripts;
   - Go `package main` through `go list`;
   - `tauri.conf.json`;
   - `pyproject.toml` with a `[project]` or `[tool.poetry]` table (issue #34), read with a small built-in TOML reader (`src/adapters/toml.mjs`, no dependency). Technology `python`; runnable when it declares `[project.scripts]`, `[project.gui-scripts]` or poetry scripts, has a `__main__.py`, or has a Dockerfile `CMD`/`ENTRYPOINT` beside it. A file with only tool configuration or a virtual uv workspace root is not a unit. Python imports are not analyzed.

   Every unit carries the manifest that proves it.
3. **The declared model enters through an adapter, not a dependency.**
   - The first adapter reads the JSON that LikeC4 exports: `likec4 export json --skip-layout`. LikeC4 is MIT-licensed, Node, and speaks C4.
   - LikeC4 is about 126 MB, so ArchSieve reads the exported file and never requires the tool. Another open format (for example Structurizr JSON) can enter the same way.
   - An element links to the code through standard LikeC4 metadata: `metadata { path '<dir>' }`.
4. **The cross-check is the product.** Each container and each link is reported in one of four states:
   - `confirmed`: declared, with evidence in the code;
   - `declared-unverified`: declared, with no static evidence;
   - `undeclared`: evidence in the code, not declared;
   - `unresolved`: a call site that cannot be resolved statically.

   There is no score.

   Amended in 0.3 (issue #3): a fifth state, `code-dependency-only`, for a declared runtime link (HTTP, IPC, stdio, child process, queue...) between containers that are coupled in code. An unrelated import must not confirm a runtime link, so only relations with no technology or a code-dependency technology are `confirmed` by imports. The mapping is in `src/model.mjs` (`linkKind`); relation metadata `link 'code' | 'runtime'` overrides it.
5. **Runtime evidence is a separate source, later.** The open standard for observing runtime links is OpenTelemetry. Static analysis never guesses a runtime link.

## Consequences

- Without a declared model, the container view shows observed units and the import links that cross them. That is useful, but it says nothing about HTTP or IPC.
- With a model, every runtime link the team believes in becomes visible as `declared-unverified` until some evidence backs it.
- Deployment (where each container runs) is the next level, and it follows the same pattern: LikeC4 `deployment` instances on the declared side, and compose, systemd or IaC manifests on the observed side. It is not built yet.
