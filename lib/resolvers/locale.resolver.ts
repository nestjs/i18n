import type {
  LocaleResolverInput,
} from '../interfaces/locale-resolver-input.interface.js';

/**
 * Finds locale candidates for a request. Pass instances, or classes that Nest
 * instantiates (so they can inject your providers), in the `resolvers` option.
 */
export abstract class LocaleResolver {
  /**
   * Request headers this resolver reads. The module lists them in the `Vary`
   * response header, so caches key responses by them.
   */
  declare readonly varyHeaders?: readonly string[];

  /**
   * Run after guards, with the `executionContext`, instead of before them:
   * for a locale saved on the user an authentication guard identifies.
   * Keeps its rank among the resolvers. On HTTP, guards (and errors they
   * throw) see the locale of the resolvers before guards; the handler sees
   * this resolver's, when it ranks above that one and returns a supported
   * locale. Runs once per request.
   */
  declare readonly afterGuards?: boolean;

  /**
   * Return a locale candidate, an ordered list of candidates, or nothing.
   * The first candidate (across all resolvers) that matches a supported
   * locale wins.
   */
  abstract resolve(
    input: LocaleResolverInput,
  ):
    | string
    | string[]
    | undefined
    | null
    | Promise<string | string[] | undefined | null>;
}
