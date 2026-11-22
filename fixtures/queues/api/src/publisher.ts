import { connect } from 'amqplib';

// Publishes extraction requests; the routing key travels through a helper.
const ROUTING_KEY = 'doc.extract.requested';
// channel.publish(exchange, 'commented.out.key', body)

export class ExtractionPublisher {
  private channel: any;
  private readonly exchange = process.env.RABBITMQ_EXCHANGE ?? 'events';

  async request(body: Buffer): Promise<void> {
    await this.send(ROUTING_KEY, body);
  }

  private async send(routingKey: string, body: Buffer): Promise<void> {
    this.channel.publish(
      this.exchange,
      routingKey,
      body,
      { persistent: true },
    );
  }
}

export async function connectBroker(url: string) {
  return connect(url);
}
