import { Queue, Worker } from 'bullmq';
import { REPORT_QUEUE } from './queue.constants';

export const reports = new Queue(REPORT_QUEUE, { connection: {} });
export const worker = new Worker(REPORT_QUEUE, async () => undefined, { connection: {} });
export const audit = new Queue('audit.events', { connection: {} });
export const dynamic = (tenant: string) => new Queue(`tenant.${tenant}`, { connection: {} });
