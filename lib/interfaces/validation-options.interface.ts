import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ValidatorOptions } from 'class-validator';

export interface TranslateValidationErrorsOptions
  extends Pick<ValidatorOptions, 'groups' | 'always' | 'strictGroups'> {
  /** Namespace for default constraint messages. Default `'validation'`. */
  namespace?: string;
}

export interface TranslateIssuesOptions {
  /** Namespace for issue-code keys. Default `'validation'`. */
  namespace?: string;
  /**
   * Extra candidate keys (without the namespace) for an issue, tried before
   * the built-in ones: `<code>.<format>`, `<code>.<origin>`, then `<code>`,
   * where `code` is `issue.code` (Zod, ArkType) or `issue.type` (Valibot),
   * `format` is `issue.format` (Zod 4 string formats such as `email`) and
   * `origin` is `issue.origin` (Zod 4: `string`, `number`, ... for `too_small`).
   */
  issueKeys?: (issue: StandardSchemaV1.Issue) => string[];
}
