import { z } from 'zod';

const email = z
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());

// bcrypt only uses the first 72 bytes of the password.
const password = z.string().min(8).max(72);

export const RegisterBodySchema = z.object({
  email,
  password,
  // Admins are created out-of-band (seed / SQL), never via self-registration.
  role: z.enum(['attendee', 'organizer']).default('attendee'),
});
export type RegisterBody = z.infer<typeof RegisterBodySchema>;

export const LoginBodySchema = z.object({
  email,
  password: z.string().min(1).max(72),
});
export type LoginBody = z.infer<typeof LoginBodySchema>;
