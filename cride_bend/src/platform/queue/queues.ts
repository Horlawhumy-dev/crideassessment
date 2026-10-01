export const QUEUE_RIDE_NOTIFICATIONS = 'ride-notifications';
export const QUEUE_RIDE_MATCHING = 'ride-matching';
export const QUEUE_RIDE_EXPIRY = 'ride-expiry';

export const ALL_QUEUES = [
  QUEUE_RIDE_NOTIFICATIONS,
  QUEUE_RIDE_MATCHING,
  QUEUE_RIDE_EXPIRY,
] as const;

export type QueueName = (typeof ALL_QUEUES)[number];

export const QUEUE_DEFAULTS: Record<QueueName, { concurrency: number; attempts: number }> = {
  [QUEUE_RIDE_NOTIFICATIONS]: { concurrency: 10, attempts: 5 },
  [QUEUE_RIDE_MATCHING]: { concurrency: 5, attempts: 3 },
  [QUEUE_RIDE_EXPIRY]: { concurrency: 5, attempts: 5 },
};
