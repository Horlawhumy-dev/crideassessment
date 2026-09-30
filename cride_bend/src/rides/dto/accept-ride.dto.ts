import { z } from 'zod';

export const acceptRideSchema = z.object({});
export type AcceptRideDto = z.infer<typeof acceptRideSchema>;
