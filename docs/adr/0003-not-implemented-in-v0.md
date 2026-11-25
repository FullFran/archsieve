# ADR 0003: What V0 deliberately does NOT implement

Status: accepted (V0) · Date: 2026-11-14

| Not implemented | Why | Revisit when |
|---|---|---|
| Own parser / AST walker | dependency-cruiser, `go list` and Nest already parse | A needed relation is invisible to all of them |
| `Analyzer` interface / plugin system | Three adapters are plain functions; no shared contract is needed yet | A third-party analyzer must plug in without editing core |
| MCP server | The CLI plus a Skill already serve any agent that can run commands | An agent cannot run shell commands |
| Graph database, persistence, daemon | JSON files on disk are enough for diff and CI | Queries over many snapshots are needed |
| UI / dashboard / SaaS | Mermaid renders in GitHub and editors; DOT for large graphs | Never in core |
| Architecture quality score | Arbitrary and gameable; the spec forbids it | Not planned |
| Own rule language and baseline | dependency-cruiser rules and `--ignore-known` baselines exist | Rules needed across non-JS analyzers (done in [ADR 0008](0008-declared-dependency-rules.md): declared rules over node ids; no baseline file, `diff` is the baseline) |
| SARIF output | Useful for code-scanning UIs, not needed for the first agent loop | CI annotations on PRs are requested |
| C4 / Structurizr | Needs system/container semantics that code imports do not prove | Deployment/IaC evidence is added |
| Rust analysis | `cargo metadata` gives crates only; module graphs need third-party tools | Rust changes cause architecture problems |
| JSON Schema `$ref` graph | Out of V0 scope | Schema-centric projects (for example HCS) need it; likely next |
| Running repository scripts or configs | Security: `--nest-entry` is the only opt-in exception | Never by default |
| npm package | The name is not final and npm names cannot be reused | Name confirmed; install from git meanwhile |
