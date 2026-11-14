## Containers of containers@aef4decebd

Which units run or ship, and how do they depend on each other?

Snapshot containers@aef4decebd · showing 9 of 9 containers and systems

```mermaid
---
title: "Containers of containers@aef4decebd"
---
flowchart LR
  n0["shop<br/>. · node<br/>in code, not in model"]:::undeclared
  n3["shop-desktop<br/>desktop/src-tauri · rust+tauri"]:::container
  n8(["Payments provider<br/>external system"]):::external
  subgraph g0["shop"]
    n1["API<br/>api · Node<br/>declared, unverified"]:::unverified
    n2["Desktop app<br/>desktop · Tauri"]:::container
    n4["CLI<br/>packages/cli · Node"]:::container
    n5["Shared library<br/>packages/shared · Node"]:::container
    n6["Store service<br/>svc · Go"]:::container
    n7["Mailer<br/>workers/mailer · Node<br/>declared, unverified"]:::unverified
  end
  style g0 fill:#f6f8fa,stroke:#57606a,color:#1f2328
  n1 -->|"imports · not in model"| n5
  n1 -.->|"spawns (child process) · unverified"| n6
  n1 -.->|"charges (HTTPS) · unverified"| n8
  n2 -.->|"calls (HTTP) · unverified"| n1
  n4 -->|"uses · imports, package-dependency"| n5
  linkStyle default stroke:#8c959f,stroke-width:1.5px
  classDef code fill:#ddf4ff,stroke:#0969da,color:#1f2328
  classDef external fill:#fff8c5,stroke:#9a6700,color:#1f2328
  classDef module fill:#fbefff,stroke:#8250df,color:#1f2328
  classDef added fill:#dafbe1,stroke:#2da44e,stroke-width:2px,color:#1f2328
  classDef removed fill:#ffebe9,stroke:#cf222e,stroke-dasharray:4 3,color:#1f2328
  classDef boundary fill:#f6f8fa,stroke:#57606a,stroke-dasharray:6 4,color:#1f2328
  classDef container fill:#ddf4ff,stroke:#0969da,stroke-width:2px,color:#1f2328
  classDef unverified fill:#ffffff,stroke:#0969da,stroke-width:2px,stroke-dasharray:5 3,color:#1f2328
  classDef undeclared fill:#fff1e5,stroke:#bc4c00,stroke-width:2px,color:#1f2328
  classDef focus fill:#ddf4ff,stroke:#0969da,stroke-width:4px,color:#1f2328
```

**Legend**

| Mark | Meaning |
| --- | --- |
| Blue box | Container: a unit that runs or ships, with its path and technology |
| Dashed blue box | Declared in the model, no manifest proves it (`declared, unverified`) |
| Orange box | Found in the code, not declared in the model (`in code, not in model`) |
| Yellow rounded box | System outside the repository, declared in the model |
| Labelled frame | The system the model declares these containers in |
| Words before the first `·` | Relation declared in the model, with its technology in brackets |
| `imports`, `lazy`, `type-only` | Code imports that cross from one container into the other, counted |
| `package-dependency` | A package.json dependency on the other container |
| Dashed arrow ending in `unverified` | Declared in the model, no static evidence in the code (runtime links such as HTTP or IPC are never visible statically) |
| Arrow ending in `not in model` | Found in the code, not declared in the model |

**Container facts**

Counted from the files in each container (lockfiles left out of files and lines); facts, not a score.

| Container | Files | Lines | Languages (lines) | Manifests | Toolchains |
| --- | ---: | ---: | --- | --- | --- |
| . | 3 | 72 | likec4 64, json 8 | package.json (0 deps) | node |
| api | 1 | 3 | javascript 3 | - | - |
| desktop | 2 | 2 | javascript 1, json 1 | package.json (0 deps) | node |
| desktop/src-tauri | 3 | 12 | rust 7, toml 4, json 1 | Cargo.toml (0 deps) | rust, tauri |
| packages/cli | 2 | 5 | javascript 4, json 1 | package.json (1 dep) | node |
| packages/shared | 2 | 2 | javascript 1, json 1 | package.json (0 deps) | node |
| svc | 3 | 12 | go 12 | go.mod (0 deps) | go |
| workers/mailer | 0 | 0 | - | - | - |
