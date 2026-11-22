import aio_pika

from .settings import load

ROUTING_KEY_COMPLETED = "doc.extract.completed"
ROUTING_KEY_FAILED = "doc.extract.failed"  # nobody consumes this
JOBS_QUEUE = "jobs.default"


class Handler:
    async def _publish(self, *, routing_key: str, body: bytes) -> None:
        msg = aio_pika.Message(body=body)
        await self._exchange.publish(msg, routing_key=routing_key)

    async def done(self) -> None:
        await self._publish(routing_key=ROUTING_KEY_COMPLETED, body=b"{}")

    async def failed(self) -> None:
        await self._publish(routing_key=ROUTING_KEY_FAILED, body=b"{}")

    async def kick(self, channel) -> None:
        await channel.default_exchange.publish(aio_pika.Message(body=b"x"), routing_key=JOBS_QUEUE)


async def main() -> None:
    settings = load()
    connection = await aio_pika.connect_robust("amqp://localhost")
    channel = await connection.channel()
    exchange = await channel.declare_exchange(settings.exchange, aio_pika.ExchangeType.TOPIC)
    queue = await channel.declare_queue(settings.queue, durable=True)
    await queue.bind(exchange, routing_key=settings.request_key)
    await queue.consume(Handler().done)
