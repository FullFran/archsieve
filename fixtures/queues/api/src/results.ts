import { connect } from 'amqplib';

const QUEUE = 'api.extraction.results';
const COMPLETED = 'doc.extract.completed';
const JOBS_QUEUE = process.env.JOBS_QUEUE ?? 'jobs.default';

export async function listen(channel: any, exchange: string, dynamic: () => string) {
  await channel.bindQueue(QUEUE, exchange, COMPLETED);
  await channel.consume(QUEUE, (msg: unknown) => msg);
  await channel.consume(JOBS_QUEUE, (msg: unknown) => msg);
  await channel.consume(dynamic(), (msg: unknown) => msg);
}

export { connect };
