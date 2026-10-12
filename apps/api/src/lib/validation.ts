import type { z } from 'zod';
import { AppError } from './errors.js';

export interface ValidationIssue {
  path: string;
  message: string;
}

export function formatIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}

/** Parse external input, throwing a 400 AppError with field-level details on failure. */
export function parse<S extends z.ZodType>(schema: S, input: unknown, what = 'request'): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw AppError.badRequest('VALIDATION_ERROR', `Invalid ${what}`, formatIssues(result.error));
  }
  return result.data;
}
