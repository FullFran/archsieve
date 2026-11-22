# ADR 0007: Message-queue links from literal names

Status: accepted · Date: 2026-11-22

## Context

ADR 0006 gave container links through child processes and HTTP, and left queues out ("IPC and queues are never evidenced"). In a monorepo whose services talk through RabbitMQ and BullMQ, the container map had no edge for the main data flows, and a queue that only one side uses was invisible. Issue #35 asks for them, on the same terms as ADR 0006: static, line patterns, `pattern` confidence, unknown when unreadable.

## Decision

- Source files already in the snapshot (JS/TS production files) and the Python files the scan lists (test files left out: `test_*.py`, `*_test.py`, `conftest.py` and the test globs) are read, but only files that name a queue library: `amqplib`, `amqp-connection-manager`, `bullmq`, `@nestjs/bullmq` (JS/TS), `aio_pika`, `pika`, `aiormq`, `kombu` (Python). Comments are blanked before reading; strings are kept. Calls are read as text with balanced arguments, so a call split over several lines works.
- **AMQP.** Producers: `channel.publish(exchange, routingKey, ...)`, `sendToQueue(queue, ...)`, aio-pika `exchange.publish(msg, routing_key=...)` and `basic_publish`. Publishing through the default exchange (empty exchange name, `default_exchange`) targets a queue named by the routing key. Consumers: a `consume(queue, ...)` call (aio-pika: `queue.consume` / `queue.iterator` on a variable bound by `declare_queue`), with the routing keys `bindQueue` / `queue.bind` attach to that same queue in the same file. A bind with no consume of its queue in the file is not a consumer. A producer routing key matches a bound key as a topic pattern (`*` one word, `#` zero or more); a producer queue matches a consumed queue by name. Exchanges are compared only when both are literals; an exchange read from configuration does not block a match.
- **BullMQ.** `new Queue(name)` and `@InjectQueue(name)` produce; `new Worker(name)` and `@Processor(name)` consume. Names match by equality.
- **Names.** A name resolves when it is a string literal, a constant (`const`/`let`/`readonly`, Python assignment) in the same file, an exported constant of a file the snapshot says this file imports (JS/TS), an environment default (`process.env.X ?? 'lit'`, `os.getenv("X", "lit")`, `os.environ.get`), or a `a ?? b` / `a or b` chain with a resolvable alternative. In Python an attribute (`settings.request_key`) or an UPPER_CASE name from another file resolves through the literal values given to that name anywhere in the same container, and only when exactly one distinct non-empty value exists. When a name is a parameter of the enclosing function, the literals its callers in the same file pass for that parameter are used (one hop), and the evidence points at the caller's line.
- **Edges.** A producer in container A and a consumer in container B (A != B) become a `runtime-link` A -> B, producer to consumer, with `relations: { amqp: n }` or `{ bullmq: n }`, `confidence: "pattern"`, and evidence with the producer and consumer `file` and `line`. A pair inside one container creates no edge and no finding. An edge for a pair that already has a child-process or HTTP edge joins it.
- **Findings.** `queue-name-unresolved` is an **unknown**, one per file with one evidence entry per call line, for a name that is not resolvable. A key, queue or BullMQ queue with a producer and no consumer anywhere in the repository (`queue-producer-without-consumer`), or a consumer and no producer (`queue-consumer-without-producer`), is a **signal**, not an error: the other side can live in another repository, a script or a broker policy, so it needs judgement. Nothing here is `error`, because no queue fact is verifiable from the commit alone.
- With `--model`, `amqp` evidences a declared link whose technology names a queue or broker (`RabbitMQ`, `AMQP`, `MQ`, `queue`, `event`), and `bullmq` one that names `BullMQ`, `Redis`, `queue` or `job`. The edge must join the declared pair in the producer-to-consumer direction.

## Own code and its justification

About 400 lines in `src/adapters/queues.mjs`. The alternatives were the same as in ADR 0006: no existing tool reports queue names from call sites, and a TypeScript or Python AST would not resolve constants across files either without a type checker. The reader stays a text pattern gated by library name, resolves only what it can prove from literals, and reports the rest as unknown. It reuses the argument splitter of the route reader.

## Consequences

- A broker topology declared outside the code (definitions JSON, Terraform, Helm), `@golevelup/nestjs-rabbitmq` or Nest `@MessagePattern` decorators, Celery, Kafka, NATS and SQS are not read: missed, not guessed.
- Wrappers more than one hop deep, names built from templates or concatenation, and queue names held in objects (`QUEUES['retry']`, `decision.queue`) are unknown findings. Dead-letter and retry queues routed with `sendToQueue(decision.queue, ...)` show up this way.
- A name defined with different values in one Python container (the same attribute in a script and in the service) is ambiguous and unresolved; empty strings are never used as names.
- A producer or consumer in a diagnostics probe or a seed script counts like any other; it can hide an orphan or create a signal. The signal message names the file and line.
- Measured on a 3,476-node monorepo (about 110 Python files, 41 files naming a queue library): 9 queue links, 3 unknown names (retry queues routed by `decision.queue`) and 2 orphan signals, with no measurable change in scan time.
