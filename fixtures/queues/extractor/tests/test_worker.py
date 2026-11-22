import aio_pika


async def test_publish(exchange):
    await exchange.publish(aio_pika.Message(body=b""), routing_key="test.only.key")
