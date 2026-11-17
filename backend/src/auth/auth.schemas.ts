import { BadRequestException, type StandardSchemaValidationPipeOptions } from '@nestjs/common';
import { z } from 'zod';

type Issues = Parameters<NonNullable<StandardSchemaValidationPipeOptions['exceptionFactory']>>[0];

export const loginSchema = z.strictObject({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'Username is required')
    .max(64, 'Username is too long')
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Username may only contain letters, digits and "-"'),
  password: z.string().min(1, 'Password is required').max(256, 'Password is too long'),
});

export type LoginDto = z.infer<typeof loginSchema>;

/**
 * Consistent 400 body for schema validation failures. Reports field paths and
 * rule messages only; submitted values (e.g. passwords) are never echoed.
 */
export function validationExceptionFactory(issues: Issues) {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message: 'Invalid request body',
    details: issues.map((issue) => ({
      path: (issue.path ?? []).map((p) => (typeof p === 'object' ? String(p.key) : String(p))).join('.'),
      message: issue.message,
    })),
  });
}
