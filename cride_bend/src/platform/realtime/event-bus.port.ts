export const EVENT_BUS = Symbol('EVENT_BUS');

export const RIDE_EVENT_TOPIC = 'bus:ride-events';

/** A bus rather than direct gateway calls: the relay may run in a worker process while the
 * sockets live on API instances, so delivery cannot depend on the two sharing a process.
 * Every API instance subscribes and emits to its own sockets. */
export interface EventBus {
  publish(topic: string, payload: unknown): Promise<void>;
  /** Returns an unsubscribe function. */
  subscribe(topic: string, handler: (payload: unknown) => void): () => void;
}
