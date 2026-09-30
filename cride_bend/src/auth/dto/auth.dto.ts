import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email().max(254).transform((v) => v.trim().toLowerCase()),
  password: z.string().min(10, 'Password must be at least 10 characters.').max(128),
  displayName: z.string().trim().min(1).max(80),
  role: z.enum(['RIDER', 'DRIVER']),
  phone: z.string().trim().max(20).optional(),
});

export const loginSchema = z.object({
  email: z.string().email().transform((v) => v.trim().toLowerCase()),
  password: z.string().min(1).max(128),
});

/**
 * Optional: the `cride.refresh` cookie is the primary credential and a browser
 * cannot read localStorage. Required here, the pipe would 400 an empty body
 * before the controller could ever read the cookie.
 */
export const refreshSchema = z.object({
  refreshToken: z.string().min(20).optional(),
});

export type RegisterDto = z.infer<typeof registerSchema>;
export type LoginDto = z.infer<typeof loginSchema>;
export type RefreshDto = z.infer<typeof refreshSchema>;
