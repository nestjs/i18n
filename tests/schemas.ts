import type { StandardSchemaV1 } from '@standard-schema/spec';
import { i18nIssueMessage } from '../lib/index.js';

/**
 * A hand-written Standard Schema whose issues mimic what real libraries emit,
 * so the tests need no zod/valibot/arktype dependency.
 */
export const signupSchema: StandardSchemaV1<unknown, Record<string, unknown>> = {
  '~standard': {
    version: 1,
    vendor: 'hand-written',
    validate(input) {
      const value = (input ?? {}) as Record<string, any>;
      const issues: StandardSchemaV1.Issue[] = [];
      if (typeof value.name !== 'string' || value.name.length < 3) {
        // Zod 4 style
        issues.push({
          code: 'too_small', origin: 'string', minimum: 3, inclusive: true,
          path: ['name'], message: 'Too small: expected string to have >=3 characters',
        } as StandardSchemaV1.Issue);
      }
      if (typeof value.email !== 'string' || !value.email.includes('@')) {
        // Zod 4 string format
        issues.push({
          code: 'invalid_format', format: 'email', path: ['email'],
          message: 'Invalid email address',
        } as StandardSchemaV1.Issue);
      }
      if (typeof value.age !== 'number' || value.age < 18) {
        // Valibot style: `type` instead of `code`, path segments are objects
        issues.push({
          kind: 'validation', type: 'min_value', expected: '>=18',
          received: String(value.age), requirement: 18,
          path: [{ key: 'age' }], message: 'Invalid value: Expected >=18',
        } as StandardSchemaV1.Issue);
      }
      if (typeof value.nickname !== 'string' || !/^[a-z]+$/.test(value.nickname)) {
        // ArkType style: params behind getters on the prototype
        issues.push(new ArkLikeIssue(['profile', 'nickname']));
      }
      if (value.referrer !== undefined) {
        // explicit key through the message string
        issues.push({
          path: ['referrer'],
          message: i18nIssueMessage('users.tooYoung', { constraint1: 99 }),
        });
      }
      if (value.coupon !== undefined) {
        // unknown code, no translation → Nest's default "path: message"
        issues.push({ code: 'custom', path: ['coupon'], message: 'Coupon expired' } as StandardSchemaV1.Issue);
      }
      return issues.length ? { issues } : { value };
    },
  },
};

class ArkLikeIssue implements StandardSchemaV1.Issue {
  constructor(readonly path: PropertyKey[]) {}
  get code() {
    return 'pattern';
  }
  get expected() {
    return '/^[a-z]+$/';
  }
  get message() {
    return 'nickname must be matched by ^[a-z]+$';
  }
}
