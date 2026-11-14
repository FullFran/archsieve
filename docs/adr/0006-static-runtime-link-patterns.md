# ADR 0006: Static runtime-link evidence from call-site patterns

Status: accepted · Date: 2026-11-14

## Context

Containers often talk at runtime, not through imports: one starts another as a child process, a desktop shell launches a sidecar, a client calls a server route. ADR 0004 leaves those links `declared-unverified`, and a model that declares them gets no evidence either way. Issue #6 asks for static evidence of runtime links, starting with child processes in JavaScript/TypeScript.

## Decision

- A line-pattern adapter reads production source files already in the snapshot (test files are skipped), but only files that name a child-process module (`child_process`, `execa`, `cross-spawn`). It recognises `spawn`, `spawnSync`, `execFile`, `execFileSync`, `fork` and `execa` calls.
- A call counts only when its program is a string literal or a `const` bound to one in the same file. The program and the literal arguments on the same line are matched to a container by path (relative to the file or to the root, existing on disk) or by a name exactly one container answers to (`package.json` `bin` keys, the unscoped package name, Cargo bin targets, a Go main package's directory).
- A match becomes a `runtime-link` edge, container to container, with `relations: { "child-process": n }`, `confidence: "pattern"` and evidence with `file` and `line`. It is never a `depends-on` link and never confirms a code dependency.
- A program that is not a literal or a same-file const is an **unknown** finding, `runtime-call-unresolved`, one per file with one evidence entry per line. A literal that matches no container is a program outside the repository: it is counted in `analyses`, not reported.
- With `--model`, a declared runtime link whose technology names a child process (`child process`, `subprocess`, `spawn`, `exec`, `stdio`, `sidecar`, `CLI`, `command line`) and has a matching `runtime-link` gets the new state `evidenced`: lower confidence than `confirmed`, which stays reserved for code evidence. Other runtime technologies (HTTP, IPC, queues) are not evidenced by a child-process call.

## Own code and its justification

About 120 lines (`src/adapters/patterns.mjs`). This is the first adapter that reads source text instead of composing an analyzer (ADR 0001). The alternatives were weighed: dependency-cruiser does not report call sites; a TypeScript AST pass would add parse cost to every file and still could not resolve a program built at runtime; semgrep or ast-grep would add a dependency and a runtime for one rule set. A line pattern gated on the module name reads only the few files that can start processes, keeps every unreadable case visible as `unknown`, and is labelled `pattern` so no consumer mistakes it for proof.

## Consequences

- Multi-line calls whose program is on a later line, aliases (`const run = spawn`) and wrappers are not recognised; they are missed, not guessed. A wrapper that takes the program as a parameter shows up as `runtime-call-unresolved`.
- `render --view containers` adds `child-process (static pattern)` to the arrow of the pair, dashed when nothing else backs it.
- Cost measured: about 17 ms for 2,000 source files with no child-process module (only the gate runs), and no measurable change on a 77-node repository.
- Rust (`Command::new`, Tauri sidecars) and HTTP route literals follow in later changes under the same rules.
