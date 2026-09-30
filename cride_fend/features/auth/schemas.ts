import { z } from 'zod';

/**
 * Client-side validation exists to be fast and to say something useful, not to be
 * the authority.
 *
 * Every rule below exists because the backend has the same one and would reject
 * the form anyway. The old app shipped no validation at all: an empty email
 * produced a round trip and a raw "MISSING_FIELD" error whose `details` was
 * never rendered, so the user saw nothing at the field that was empty.
 *
 * Note what is *not* here: no password-strength rule, no capitalisation rule, no
 * invented confirmation logic. Those produce forms that reject passwords people
 * can remember and accept passwords nobody should use. §9.2 has no payments, so
 * the account is the only thing an attacker would want, and length is the
 * measure that matters.
 */

export const emailSchema = z
  .string()
  .min(1, 'Enter your email address.')
  // Not `z.string().email()`: that pattern rejects addresses RFC 5322 permits,
  // and a rejection here means an account the user can never create.
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'That does not look like an email address.');

export const passwordSchema = z
  .string()
  .min(1, 'Enter your password.')
  .min(10, 'Use at least 10 characters.');

export const displayNameSchema = z
  .string()
  .min(1, 'Tell us your name.')
  .max(80, 'That name is too long.');

export const phoneSchema = z
  .string()
  .optional()
  .refine(
    (value) => !value || /^\+?[0-9\s()-]{7,20}$/.test(value),
    'Enter a phone number, or leave it empty.',
  );

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.'),
});

export const registerSchema = z.object({
  displayName: displayNameSchema,
  email: emailSchema,
  password: passwordSchema,
  phone: phoneSchema,
  role: z.enum(['RIDER', 'DRIVER']),
});

export type SignInInput = z.infer<typeof signInSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;

/** Where to send someone after a successful sign-in or registration. */
export function landingPathFor(role: 'RIDER' | 'DRIVER'): string {
  return role === 'RIDER' ? '/rider' : '/driver';
}
