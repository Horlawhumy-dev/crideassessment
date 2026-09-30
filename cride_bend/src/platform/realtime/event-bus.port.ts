export const EVENT_BUS = Symbol('EVENT_BUS');

export const RIDE_EVENT_TOPIC = 'bus:ride-events';

/** Not a direct gateway call: the relay may run in a worker process while the sockets live
 * on API instances, so delivery must not depend on the two sharing a process. Every API
 * instance subscribes and emits to its own sockets instead. */
export interface EventBus {
  publish(topic: string, payload: unknown): Promise<void>;
  /** Returns an unsubscribe function. */
  subscribe(topic: string, handler: (payload: unknown) => void): () => void;
}
