# Tool comparison matrix (2026-11-14)

Facts from primary sources (GitHub repos and API, npm registry, official docs, LICENSE files) collected on 2026-11-14. `UNVERIFIED` marks what was not confirmed.

## Question: does an existing project already solve this?

No project found combines: a deterministic import graph + framework DI graph, provenance per relation, an explicit verified / heuristic / unknown split, a before/after architecture diff, and portable agent packaging. The closest projects are young single-maintainer efforts (Atlas, Archprint) or have licenses that exclude commercial use (GitNexus). ArchSieve composes the mature pieces and keeps its own code to normalization and diffing.

| Tool | Category | What it gives us | License | Maintenance | Limitation | Verdict |
|---|---|---|---|---|---|---|
| dependency-cruiser | Static imports (JS/TS) | Import graph, cycles, rules, `json`/`dot`/`mermaid`/`baseline` outputs, `--ignore-known` | MIT | v18.7.2 (2026-11-02), ~7.4k stars | No DI or runtime semantics; ignores `.gitignore`; computed `import()` invisible | **Core dependency** |
| `@nestjs/core` SerializedGraph | NestJS DI graph | Modules, providers, controllers, injections (`snapshot` + `preview`) | MIT | Active, ~77k stars | Needs the app to load (module top-level code runs); factory internals invisible | **Core (opt-in)** |
| NestJS Devtools UI | DI visualizer | Hosted UI reading `graph.json` | Package MIT; hosted app terms UNVERIFIED | v12.0.0 (2026-08-27) | Hosted, no CI/diff | Do not depend on the UI |
| `go list` (Go toolchain) | Go packages | Package import graph, offline with `GOPROXY=off` | BSD-3-Clause (Go) | Official | Build-tag dependent | **Core for Go** |
| NestJS Doctor | NestJS lint | 52 rules, SARIF, HTML module graph | MIT | v1.0.0 (2026-07-27) | Rule scorer; telemetry on by default; no stable graph JSON | Complement later |
| CodeGraphContext | Code graph + MCP | Symbol graph in a graph DB | MIT | v0.5.7 (2026-08-08), ~4.4k stars | Python + graph DB; no provenance split | Reference only |
| Code Maat | Git history | Change coupling, hotspots | LICENSE not read (UNVERIFIED) | v1.0.4 (2023-02-20) | Temporal only; Clojure | Later signal source |
| Archprint | Rule inference | Infers rules from imports; emits ESLint/dependency-cruiser rules; MCP | MIT | v0.18.3 (2026-11-14), 8 stars | Very young; no DI graph or diff | **Watch / possible partner** |
| Digital-Threads/atlas | NestJS graph + MCP | Routes, DI, queues, DB graph; `.atlas/graph.json` | MIT | 1 star, no releases | Own schema; no diff; maturity unproven | Evaluate before V1 |
| GitNexus | Code graph + MCP | Symbol/call graph, agent setup | **PolyForm-Noncommercial-1.0.0** | v1.6.12, ~48.5k stars | Non-commercial license | **Do not build on it** |
| Nx project graph | Monorepo | Project-level graph | MIT | Very active | Needs Nx; project granularity | Not applicable (no Nx) |
| madge | Static imports | Import graph, cycles | MIT | v8.0.0 (2024-08) | Strictly less than dependency-cruiser | Skip |
| ArchUnitTS / ts-archunit / eslint-plugin-boundaries | Governance | Architecture assertions / lint | MIT | Active / young / active | Tests or lint, not evidence graphs | Optional enforcement targets |
| Packwerk | Governance (Ruby) | Boundaries + todo baselines | MIT | Active | Ruby only | Borrow the baseline lesson |
| Coratch/ArchProof, songshusyu/archproof | Governance / skill | ADR-based PR checks; claim-audit skill | Apache-2.0 | 0 stars | LLM-backed; different problem | Pattern reference |
| Mermaid | Visualization | Text diagrams, GitHub-rendered | MIT | ~91k stars | Unreadable above a few hundred edges | **Primary view** |
| Graphviz DOT | Visualization | Scales to large graphs | UNVERIFIED (EPL per project site) | Mature | Needs `dot` installed | **Secondary view** |
| D2 | Visualization | Text diagrams | MPL-2.0 | Active | Another renderer to install | Skip |
| C4 / Structurizr | Visualization | System/container/component model | Apache-2.0 | `structurizr/structurizr` active | Model is authored, not derived | Skip until semantics exist |
| JSON Schema 2020-12 | Interchange | Contract for our JSON | Spec | Current draft | None | **Adopt** |
| SARIF 2.1.0 | Interchange | Findings for code-scanning UIs | OASIS standard | Stable | Findings, not graphs | V1, for findings only |
| Agent Skills | Agent integration | Portable `SKILL.md` | Apache-2.0 | Active | Packaging only | **Adopt** |
| MCP | Agent integration | Tool protocol | Spec | Active | Duplicates the CLI for V0 | Defer |

## Lessons carried over

- Packwerk retrospective: dependency checks plus todo baselines worked; privacy checks were dropped; stale todos were never cleaned; zero violations does not mean the code runs, because static analysis misses dependencies. Hence the verified / heuristic / unknown split, and reuse of dependency-cruiser's own baseline for ratcheting.
- Name check: no GitHub repository or npm package named `archsieve` or `arch-sieve` as of 2026-11-14. Domains, trademarks and other registries were not checked.

## Sources

dependency-cruiser (github.com/sverweij/dependency-cruiser), nestjs/nest (`packages/core/inspector`, `nest-application-context-options.interface.ts`), docs.nestjs.com/devtools/overview, RoloBits/nestjs-doctor, CodeGraphContext/CodeGraphContext, adamtornhill/code-maat, Tommkruix/archprint, Digital-Threads/atlas, abhigyanpatwari/GitNexus (LICENSE), nrwl/nx, pahen/madge, LukasNiessen/ArchUnitTS, nielspeter/ts-archunit, javierbrea/eslint-plugin-boundaries, Shopify/packwerk, shopify.engineering/a-packwerk-retrospective, Coratch/ArchProof, songshusyu/archproof, mermaid-js/mermaid, terrastruct/d2, structurizr/structurizr, json-schema.org/specification, agentskills.io/specification.
