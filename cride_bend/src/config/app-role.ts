export type AppRole = 'api' | 'worker' | 'all';

/** Three boot shapes, split at the composition root: API latency and queue workload scale on different axes. */
export const APP_ROLES: readonly AppRole[] = ['api', 'worker', 'all'];

export function resolveRole(env: NodeJS.ProcessEnv = process.env): AppRole {
  const raw = env.APP_ROLE;
  if (raw === 'api' || raw === 'worker' || raw === 'all') return raw;
  return 'all';
}

export function servesHttp(role: AppRole): boolean {
  return role === 'api' || role === 'all';
}

export function runsWorker(role: AppRole): boolean {
  return role === 'worker' || role === 'all';
}

export function servesWebSocket(role: AppRole): boolean {
  return role === 'api' || role === 'all';
}
