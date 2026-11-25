# ADR 0008: Declared dependency rules over node ids

Status: accepted · Date: 2026-11-25

## Context

ArchSieve shows the graph and diffs two snapshots, but cannot answer "is this import allowed?". A gate could only fail on findings ArchSieve already knows (`diff --fail-on error`), so every repository wrote its own test to keep, for example, a Go domain package away from its adapters. ADR 0001 left rules to dependency-cruiser and ADR 0003 deferred an own rule language until "rules are needed across non-JS analyzers". Issue #28 is that case: the same question is asked of JS/TS files, Go packages and NestJS providers, and dependency-cruiser only sees the first.

## Decision

- `scan --rules <file>` reads a JSON rules file (`schema/rules.schema.json`, checked by `validate`). The user declares every rule; ArchSieve ships none and imposes no architecture.
- The vocabulary is dependency-cruiser's, so nothing new has to be learned: `forbidden` rules with a `name`, `allowed` rules, each with `from` and `to` objects holding `path` and `pathNot` regular expressions (a string or a list). In `to`, `$1`..`$9` reuse the groups of the `from.path` match.
- Patterns match **node ids**, not syntax: a file path (`src/a/x.ts`), `go:<import path>`, `npm:<package>`, `nest:...`. One rules file covers every analyzer.
- Only edges a parser or the framework reported are checked: `imports` (dependency-cruiser and `go list`), `nest-imports` and `nest-injects`. `runtime-link` and `references` edges have `pattern` confidence and `depends-on` is derived or declared, so none of them can prove a violation.
- An edge that matches a forbidden rule is an **error** finding whose `rule` is the rule's name and whose subjects are the edge's source and target (`id` = `<name>:<source>|<target>`, stable while the rule name and the edge exist). When `allowed` is present, an edge that matches none of its rules is a `not-in-allowed` error, as in dependency-cruiser. The evidence is the edge's own evidence plus `{ tool: "archsieve rules", file: <rules file>, detail: "forbidden[i]" | "allowed" }`.
- A declared rule broken by a scanned edge is a verifiable fact, so there is no severity field: rules produce errors only. `diff --fail-on error` therefore fails a change that adds a violation, while a violation already in the baseline is not new.
- A rules file that cannot be read, is not JSON, breaks the schema, repeats a rule name or holds an invalid regular expression stops `scan` with exit 2 before anything is scanned. A broken rules file never becomes a silent pass.

## Own code and its justification

About 100 lines in `src/rules.mjs`. The alternatives were exporting the snapshot to dependency-cruiser (JS files only), go-arch-lint (Go only) or ArchUnit (Java). None covers the graph ArchSieve already holds, and each would add a runtime. Matching regular expressions over node ids is the smallest rule engine that works for every analyzer, and reusing dependency-cruiser's shape keeps the rules portable in both directions.

## Consequences

- dependency-cruiser's other rule conditions (`circular`, `orphan`, `dependencyTypes`, `reachable`, ...) are not supported. Cycles and orphans already are built-in findings.
- Type-only imports count like any other import: they are compile-time dependencies. A rule that should ignore them is not expressible yet.
- A rule over a pattern-confidence edge (a runtime link between containers) is not checked; such rules need the evidence to become verifiable first.
- This revisits the "Own rule language" row of ADR 0003 and the "rules are dependency-cruiser rules" line of ADR 0001: the built-in `no-circular` and `no-orphans` stay dependency-cruiser rules.
