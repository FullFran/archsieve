# ADR 0006: Static runtime-link evidence from call-site patterns

Status: accepted · Date: 2026-11-14

## Context

Containers often talk at runtime, not through imports: one starts another as a child process, a desktop shell launches a sidecar, a client calls a server route. ADR 0004 leaves those links `declared-unverified`, and a model that declares them gets no evidence either way. Issue #6 asks for static evidence of runtime links, starting with child processes in JavaScript/TypeScript.

## Decision

- A line-pattern adapter reads production source files already in the snapshot (test files are skipped), but only files that name a child-process module (`child_process`, `execa`, `cross-spawn`). It recognises `spawn`, `spawnSync`, `execFile`, `execFileSync`, `fork` and `execa` calls.
- Rust files have no graph in the snapshot, so the scan lists them (tracked plus untracked-but-not-ignored, `target/` and test globs left out) and reads only those that contain `Command::new` or `.sidecar(`. `Command::new` is a `child-process` relation; Tauri `.sidecar("name")` and `Command::new_sidecar` are a `sidecar` relation.
- A call counts only when its program is a string literal or a constant bound to one in the same file (`const` in JS/TS, `const`/`static` `&str` in Rust). The program and the literal arguments on the same line are matched to a container by path (relative to the file or to the root, existing on disk) or by a name exactly one container answers to (`package.json` `bin` keys, the unscoped package name, Cargo bin targets, a Go main package's directory, the last element of a `go.mod` module path, which is the name `go build` gives the binary). A path that does not exist, such as build output, falls back to its file name when it has no extension; `.exe` and a target-triple suffix are removed first.
- A match becomes a `runtime-link` edge, container to container, with `relations: { "child-process": n }`, `confidence: "pattern"` and evidence with `file` and `line`. It is never a `depends-on` link and never confirms a code dependency.
- A program that is not a literal or a same-file const is an **unknown** finding, `runtime-call-unresolved`, one per file with one evidence entry per line. A literal that matches no container is a program outside the repository: it is counted in `analyses`, not reported.
- HTTP: route definitions (JS/TS `app|router|server|fastify….get('/x')` and Nest `@Controller` + `@Get`; Go `HandleFunc`/`Handle` including Go 1.22 `"GET /x"`, gin/echo/chi methods; Rust axum `.route("/x")` and `#[get("/x")]` attributes) and client calls (JS/TS `fetch`, `axios`, `ky`, `got`; Go `http.Get`/`NewRequest…` and `*client.Get`; Rust `reqwest` and `*client.get`) are read from JS/TS, Go and Rust files. Paths are normalised to segments; parameters (`:id`, `{id}`, `<id>`) and interpolations (`${x}`, `+ x`, `%s`, `{}`) become `*`, and a base URL or a leading interpolation is dropped. A call is an `http-route` relation only when its path matches routes of exactly one other container, with at least one literal segment in common; ambiguous matches, calls that match no route (external APIs) and calls without a literal path are counted in `analyses`, not reported as links.
- With `--model`, a declared runtime link gets the new state `evidenced` when a `runtime-link` of a matching kind joins the same pair: `child-process` and `sidecar` relations evidence technologies naming a child process (`child process`, `subprocess`, `spawn`, `exec`, `stdio`, `sidecar`, `CLI`, `command line`); `http-route` evidences `HTTP`, `HTTPS`, `REST`, `JSON` or `API`. `evidenced` is lower confidence than `confirmed`, which stays reserved for code evidence; IPC and queues are never evidenced.

## Own code and its justification

About 300 lines (`src/adapters/patterns.mjs`, `src/adapters/routes.mjs`). This is the first adapter that reads source text instead of composing an analyzer (ADR 0001). The alternatives were weighed: dependency-cruiser does not report call sites; a TypeScript AST pass would add parse cost to every file and still could not resolve a program built at runtime; semgrep or ast-grep would add a dependency and a runtime for one rule set. A line pattern gated on the module name reads only the few files that can start processes, keeps every unreadable case visible as `unknown`, and is labelled `pattern` so no consumer mistakes it for proof.

## Consequences

- Multi-line calls whose program is on a later line, aliases (`const run = spawn`) and wrappers are not recognised; they are missed, not guessed. A wrapper that takes the program as a parameter shows up as `runtime-call-unresolved`.
- `render --view containers` adds `child-process (static pattern)` to the arrow of the pair, dashed when nothing else backs it.
- Cost measured: about 17 ms for 2,000 source files with no child-process module (only the gate runs), and no measurable change on a 77-node repository.
- Routes mounted under a prefix elsewhere (`app.use('/api', router)`, gin groups, axum `nest`) are compared without the prefix and usually match nothing: missed, not guessed. A path served by several containers is ambiguous and not linked.
- Cost measured on HTTP: 19 ms on 2,000 source files; no links and no unknowns on a 241-node real JS code base without runtime calls.
