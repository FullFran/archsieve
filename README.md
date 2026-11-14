# ArchSieve

**Architecture evidence for coding agents.** *Evidence before abstractions.*

> Experimental V0 (provisional name). Apache-2.0. Not on npm yet: install from git.

Coding agents add interfaces, layers, services and abstractions that the code does not need, even when the code works. ArchSieve gives them, and you, a deterministic picture of the real architecture, plus a before/after diff of each change, so every new abstraction becomes a visible cost that has to answer a real need.

It does not impose Clean Architecture, DDD or hexagonal. Simplicity is not "fewer classes".

## What it does

```
repo or commit ──► existing analyzers ──► snapshot.json ──► diff / Mermaid / DOT ──► agent or human
                   (dependency-cruiser,     (provenance,
                    go list, NestJS DI)      error/signal/unknown)
```

- **scan**: runs existing analyzers and normalizes their output into one JSON snapshot. Every node and edge records which tool reported it.
- **diff**: compares two snapshots: nodes, edges, component-level dependencies and findings that are new or resolved. `--fail-on error` turns it into a CI gate.
- **render**: Mermaid, DOT or Markdown views (containers, components, files, NestJS DI), optionally coloured against a previous snapshot. Each diagram has a title, keeps to a budget of boxes and arrows (`--max-nodes`, `--max-edges`), and can zoom into a folder (`--within`) or one element (`--focus`). `--format md` adds the concern, what is shown out of what, and a legend.
- **affected**: which files and tests depend on a set of changed files (`--changed <file> ...` or `--base <git-ref>`): the reverse closure over the snapshot's imports, the test files inside it, and `blind`, every reason the answer may be incomplete (changed files outside the graph such as configs, lockfiles or data; unresolved imports that may point into the closure; skipped analyses; a snapshot from another commit). A pre-push hook can run `tests` and fall back to the full suite when `blind` is not empty. No runner integration and no prediction. `--ignore '**/*.md'` drops changed files the caller knows are irrelevant.
- **history** (opt-in `scan --history`): churn per file, Go package and container from `git log` (read only) over a window anchored at the scanned commit (`--since 90d`), and `co-change-without-link` signals for containers that change together with no import or package dependency between them (`--co-change-min 5`). See [ADR 0005](docs/adr/0005-change-history-signals.md).
- **validate**: checks documents against the JSON Schemas in `schema/`.
- **tests vs production**: scan marks files matching test globs (`--test-globs`, default `**/test/**`, `**/tests/**`, `**/__tests__/**`, `**/*.test.*`, `**/*.spec.*`, `**/*_test.*`) with `test: true`. Container and component arrows show the test share (`imports x152 (test x148)`), and `render --no-tests` / `diff --no-tests` leave imports from test files out, so a production coupling change is not buried under test helpers. The mark is a path convention, not proof.

Findings have three levels and nothing else:

| Level | Meaning | Examples |
|---|---|---|
| `error` | Verifiable from the evidence for this commit | runtime import cycle, DI cycle, module cycle |
| `signal` | Heuristic; needs judgement, not obedience | orphan file, cycle through type-only imports, provider behind a token with one binding |
| `unknown` | Not inferable from static evidence | unresolved import, factory/value provider, Go package load error |

There is no quality score.

## Quick start

```bash
git clone https://github.com/FullFran/archsieve && cd archsieve
npm install
npm test                       # 11 integration tests, no network
npm run demo                   # regenerates examples/nest-shop/

# any local repo (JS/TS/MJS + Go), working tree or a commit, never modifies it
node bin/archsieve.mjs scan ../my-repo -o /tmp/as/now.json
node bin/archsieve.mjs scan ../my-repo --ref main -o /tmp/as/main.json
node bin/archsieve.mjs diff /tmp/as/main.json /tmp/as/now.json --format md
node bin/archsieve.mjs render /tmp/as/now.json --depth 1 > /tmp/as/components.mmd
node bin/archsieve.mjs affected /tmp/as/now.json --base origin/main --repo ../my-repo   # files, tests, blind
```

`npm link` puts `archsieve` on your PATH. To use it as a dev dependency of another project, pin a tag:
`npm install --save-dev https://github.com/FullFran/archsieve/archive/refs/tags/v0.3.0.tar.gz` (the tag tarball keeps an `integrity` hash in the lockfile; a `github:` spec is locked as `git+ssh`, which needs a GitHub SSH key to install).

## Example (synthetic NestJS fixture)

`fixtures/nest-shop/after` adds three things to `before`: a repository behind a string token, a `forwardRef` cycle between `UsersService` and `OrdersService`, and a factory provider. From `examples/nest-shop/diff.md`:

- **4 errors**: the Nest DI cycle, the module import cycle, and two runtime file cycles.
- **2 signals**: `InMemoryUsersRepository` behind token `USERS_REPOSITORY` with one binding (an abstraction that has to justify itself), and a cycle that exists only through type-only imports (erased at runtime, so not an error).
- **1 unknown**: the `CLOCK` factory provider, whose dependencies the DI graph cannot show.

![Nest DI compared](examples/nest-shop/nest-compare.svg)

### Reading a diagram

| Arrow | Meaning |
|---|---|
| `A --> B` labelled `imports` | A imports B with a static import: B must be loaded for A to run |
| `A --> B` labelled `lazy` | A loads B with a dynamic `import()` |
| `A -.-> B` labelled `type-only` | A only uses B's types; the import is erased at compile time |
| `A -.-> B` labelled `imports` (Nest view) | Nest module A imports module B |
| `A --> B` labelled `injects` (Nest view) | Nest class A receives B through dependency injection |
| `x3` after a label | in the components view, the arrow groups 3 file-level imports of that kind |

Boxes are blue for code, yellow for npm packages and purple for Nest modules. In a compared view, green marks what was added and red what was removed.

## Supported today

| Stack | Analyzer | Notes |
|---|---|---|
| JS / TS / MJS / TSX | dependency-cruiser 18.7.2 | Type-only imports are labelled. Vendored dirs (`vendor/`, `third_party/`, `node_modules/`) are boundaries and are not followed. Git-ignored dirs are excluded. |
| Go | `go list` | Offline (`GOPROXY=off`). Standard library omitted. |
| NestJS DI | `@nestjs/core` SerializedGraph, `preview: true` | Opt-in `--nest-entry <compiled module>`. **Runs module top-level code**; providers are not instantiated. |
| Units (containers, packages) | manifests read as data; `cargo metadata --no-deps --offline` | Every `package.json`, `Cargo.toml`, `go.mod`, Go `package main` and `tauri.conf.json` becomes a `container` node with its technology, whether it can run (`bin`, `scripts.start`, a Cargo bin, `package main`) and the manifest that proves it. Imports that cross units and `package.json` dependencies on another unit become `depends-on` links. Child processes started from JS/TS with a literal program (`spawn`, `execFile`, `fork`, `execa`) become `runtime-link` edges at `pattern` confidence, with file and line; a program built at runtime is an unknown `runtime-call-unresolved` finding ([ADR 0006](docs/adr/0006-static-runtime-link-patterns.md)). HTTP, IPC and queues are not visible. `--no-units` skips it. See [ADR 0004](docs/adr/0004-container-level.md). |
| Declared model | LikeC4 JSON export (`likec4 export json --skip-layout`) | Opt-in `--model <file>`. LikeC4 is not required: only its exported JSON is read. An element with `metadata { path '<dir>' }` is matched to the unit at that path (a path without a manifest becomes a unit). Each container and link gets a state: `confirmed`, `declared-unverified`, `undeclared`, `code-dependency-only` or `evidenced` (a declared child-process link with a matching call site, read by a static pattern). A declared link is `confirmed` by imports only when its technology is empty or names a code dependency (`import`, `library`, `npm package`, `package`, `module`, `crate`, `go module`, `code`, `in-process`, `function call`); any other technology (HTTP, IPC, stdio, child process, queue, or one not recognised) is a runtime link, and imports between the two containers only make it `code-dependency-only`. Relation metadata `metadata { link 'code' }` or `link 'runtime'` overrides the mapping. Gaps are findings: undeclared containers and links are signals, declared links without static evidence are unknown. `render --view containers` draws it: see [examples/containers](examples/containers/containers.md). |

## Known limitations

- Static evidence only: no HTTP, IPC, queues or events; child processes only when the program is a literal (pattern confidence). A clean result does not mean the system is correct.
- Path aliases (`@/...`) need the tsconfig that defines them. When unresolved imports match `compilerOptions.paths` in a tracked `tsconfig*.json`, scan adds a `ts-config-hint` signal naming the exact `--ts-config <file>` flag; `--ts-config auto` uses that tsconfig when exactly one matches (and says so in `analyses`). tsconfig files are read as data, never executed. One tsconfig applies to the whole scan.
- dependency-cruiser cannot see computed `import(\`./x/${name}\`)`; such imports are neither edges nor findings.
- `--ref` resolves packages against the **current** `node_modules`, not the install at that commit.
- Rust, Python and PowerShell are not analyzed. JSON Schema `$ref` graphs (relevant for HCS) are not analyzed yet.
- Mermaid becomes unreadable beyond a few hundred edges: use `--depth 1` or `--format dot`.
- Tests were written after a spike, as characterization tests, not test-first.

## Security

- Offline by default. Nothing is uploaded.
- ArchSieve never runs repository scripts or loads repository JS configs. The only exception is the explicit `--nest-entry`.
- Write snapshots of private repositories outside the repository and do not publish them.

## Agents

`skills/archsieve/SKILL.md` is an [Agent Skills](https://agentskills.io/specification) skill (Claude Code, OpenCode, Pi, Codex). It is linked into `.claude/skills/` for this repository. No MCP server is needed: the agent runs the CLI.

## Design records

- [ADR 0001](docs/adr/0001-compose-existing-analyzers.md): compose existing analyzers.
- [ADR 0002](docs/adr/0002-minimal-json-model.md): minimal JSON model with three evidence levels.
- [ADR 0003](docs/adr/0003-not-implemented-in-v0.md): what V0 deliberately does not implement.
- [ADR 0004](docs/adr/0004-container-level.md): container level, declared model and cross-check.
- [ADR 0005](docs/adr/0005-change-history-signals.md): change history as a separate signal source.
- [ADR 0006](docs/adr/0006-static-runtime-link-patterns.md): static runtime-link evidence from call-site patterns.
- [Tool matrix](docs/research/tool-matrix.md): comparison with existing tools.

## License

Apache-2.0. See [LICENSE](LICENSE).
