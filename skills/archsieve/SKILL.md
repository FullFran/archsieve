---
name: archsieve
description: "Trigger: architecture of this repo, before/after a refactor, new layer/service/interface, dependency cycle, module graph. Gets deterministic architecture evidence (graph, diff, diagrams) before and after code changes."
license: Apache-2.0
compatibility: "Node >= 22. Optional: Go toolchain for Go packages. Works offline; no LLM needed."
metadata:
  author: "FullFran"
  version: "0.1"
---

## Activation Contract

Use before designing or reviewing a structural change (new module, service, interface, layer, cross-component import) and after making it. Not for runtime behavior, performance or security review.

## Hard Rules

- The snapshot JSON is the source of truth. Never add, hide or rename nodes/edges you did not get from it; diagrams are views.
- `error` findings are verifiable facts for this commit. `signal` findings are heuristics: argue with them, do not obey them. `unknown` means "not inferable", never "absent".
- Keep AS-IS (scanned) and TO-BE (your proposal) separate. Label proposals explicitly as proposals.
- An added abstraction is a visible cost, not a defect: justify each new module/provider/interface/token with a concrete need (second implementation, test seam, security or deployment boundary, ownership).
- Never run `--nest-entry` on code you do not trust: it executes module top-level code.
- Do not upload snapshots of private repositories anywhere.

## Decision Gates

| Situation | Command |
|---|---|
| Understand current structure | `archsieve scan <repo> -o /tmp/as/now.json` then `archsieve render /tmp/as/now.json --depth 1` |
| Compare your uncommitted work with HEAD | `scan <repo> --ref HEAD -o before.json`, `scan <repo> -o after.json`, `diff before.json after.json --format md` |
| Compare two commits / branches | `scan <repo> --ref <a>` and `--ref <b>`, then `diff` |
| Gate in CI | `diff base.json head.json --fail-on error` (exit 1 on new verifiable regressions) |
| Coupling buried under test helpers (`imports x152 (test x148)`) | `render ... --no-tests` or `diff ... --no-tests`; custom test layout: `scan --test-globs '<glob>,...'` |
| Which tests to run for a change | `scan <repo> -o now.json`, then `affected now.json --base <ref> --repo <repo>`; run `tests`, or everything when `blind` is not empty |
| Many `unresolved-import` unknowns, or a `ts-config-hint` signal | rescan with the `--ts-config <file>` the hint names, or `--ts-config auto` |
| Which containers start or call which at runtime (child processes, sidecars, HTTP routes) | `scan <repo>` then `render --view containers`; `runtime-link` edges are `pattern` confidence, `runtime-call-unresolved` unknowns are call sites nobody can read statically |
| Where change cost concentrates, or couplings imports cannot show | `scan <repo> --history [--since 180d]`; read `churn` on containers and `co-change-without-link` signals (questions, not facts) |
| NestJS DI wiring (trusted code, compiled) | add `--nest-entry dist/app.module.js`; view with `render --view nest` |

## Execution Steps

1. Run `archsieve` if on PATH, else `node <archsieve-checkout>/bin/archsieve.mjs`. Write artifacts outside the repo (e.g. `/tmp/archsieve/`).
2. Before the change: scan `--ref HEAD`; read `findings` and the component diagram; note existing errors (baseline debt, not yours).
3. Make the change. Scan the working tree; run `diff --format md`.
4. For each NEW `error`: fix it or explain why it is intended. For each NEW `signal` and new component dependency: state the need it answers or simplify. For `unknown`: say what evidence is missing.
5. Report using the Output Contract.

## Output Contract

Short report: commits compared; new errors (with fix or justification); new component dependencies; new abstractions and the need each answers; unknowns; limitations that matter for this change. Quote rule ids and node ids exactly.

## References

- `references/model.md`: snapshot fields and finding levels.
