# ADR 0002: Minimal versioned JSON model with three evidence levels

Status: accepted (V0) · Date: 2026-11-14

## Context
No standard architecture-graph interchange format fits (SARIF is for findings; GraphML/JGF add nothing an agent needs). The spec allows a small internal contract with JSON Schema.

## Decision
- One snapshot document (`schemaVersion: "0.1"`) and one diff document, both JSON Schema 2020-12, validated with Ajv in strict mode.
- Every node and edge carries `evidence[]` (tool, and file/specifier only when the tool reports them; no invented line numbers).
- Findings have exactly three levels: `error` (verifiable from the evidence), `signal` (heuristic, needs judgement), `unknown` (not inferable). No score.
- Output is deterministic: sorted, no timestamps, no absolute paths, so the same commit gives byte-identical files.
- The snapshot is AS-IS only. TO-BE proposals are never written into it.

## Consequences
- The schema will change; 0.x gives no compatibility promise beyond a minor version.
- Classification decisions are explicit and tested: a cycle through type-only imports is a `signal` (erased at runtime), not an `error`.
