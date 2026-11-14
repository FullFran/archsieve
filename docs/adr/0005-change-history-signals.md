# ADR 0005: Change history as a separate signal source

Status: accepted · Date: 2026-11-14

## Context

Import graphs miss couplings that only show when files change together: a schema and its readers, both ends of a protocol, a desktop shell and the service it calls over HTTP. Change coupling and hotspots (Adam Tornhill's Code Maat) measure this from version control. Issue #5 asks for churn per file and per container, and co-change between containers that have no import between them.

## Decision

- An opt-in `--history` analysis reads `git log --name-only --no-renames --no-merges` (read only) and adds `churn` (commits in the window) to file, Go package and container nodes, plus `co-change-without-link` **signal** findings.
- A pair of containers is reported when they changed together in at least `--co-change-min` commits (default 5) and in at least half of the commits of the less active one, and no `depends-on` link with observed relations joins them. Co-change is never an error and never becomes a link.
- The window (`--since <N>d`, default 90 days) is anchored at the scanned commit's committer date, not at the current time, so the same commit gives the same snapshot (ADR 0002). An ISO date is also accepted.
- Commits touching more than 50 files are left out (formatting sweeps, renames, vendoring), as Code Maat does with large changesets; the count is reported in `analyses`.

## Own code and its justification

About 80 lines (`src/adapters/history.mjs`). Code Maat is a Clojure/JVM tool whose last release is from 2023 and whose license was not verified (tool matrix); it would add a runtime and still need normalization into the snapshot. The two metrics needed here (commits per path, shared commits per pair) are counts over `git log` output.

## Consequences

- History is heuristic evidence about the team's work, not about the code. A clean history says nothing; a co-change signal asks a question.
- `--ref` reads the history of that commit. A dirty working tree does not change the result.
- Cost measured on a synthetic repository with 5,000 commits: about 0.5 s on top of the scan.
