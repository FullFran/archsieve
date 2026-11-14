# ADR 0001: Compose existing analyzers; own code is normalization and diff only

Status: accepted (V0) · Date: 2026-11-14

## Context
Agents need a verifiable architecture graph. Mature tools already extract the hard parts: dependency-cruiser (JS/TS imports, cycles, rules), the Go toolchain (`go list`), and NestJS's own SerializedGraph (DI as Nest registers it). The first target repositories are mostly JavaScript/TypeScript (`.mjs` scripts, a React desktop app), with some Go, and do not use NestJS. The NestJS adapter is therefore opt-in and validated on synthetic fixtures.

## Decision
- dependency-cruiser 18.7.2 (MIT), run as a subprocess with a generated config, is the JS/TS analyzer.
- `go list` (offline: `GOPROXY=off`, `-mod=readonly`) is the Go analyzer.
- NestJS SerializedGraph in `preview` mode is an opt-in analyzer (`--nest-entry`), validated on fixtures.
- ArchSieve code is limited to: running these tools, normalizing to one small JSON model with provenance, classifying findings, diffing two snapshots, and projecting views (Mermaid/DOT).

## Own code and its justification
| Code | Why no existing tool covers it |
|---|---|
| Normalizer (~200 lines) | Each tool has its own JSON shape; a diff needs one stable shape with provenance |
| Diff (~120 lines) | dependency-cruiser's baseline answers "new violations", not "which nodes, edges and component dependencies changed" |
| Cycle detection on DI / Go graphs (Tarjan, ~30 lines) | SerializedGraph and `go list` do not report cycles |
| Mermaid/DOT views with compare colouring | dependency-cruiser renders its own graph only, without DI edges or before/after state |

## Consequences
- Rules are dependency-cruiser rules. ArchSieve does not define a rule language.
- Analyzer quirks become ArchSieve behaviour and must be pinned by tests (for example, `.gitignore` is ignored by dependency-cruiser, so ArchSieve excludes git-ignored directories itself).
