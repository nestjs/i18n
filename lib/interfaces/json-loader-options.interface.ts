export interface JsonI18nLoaderOptions {
  /** Directory holding one sub-directory per locale: `<path>/<locale>/<ns>.json`. */
  path: string;
  /**
   * Reload the catalogs when files change (development only). Everything is
   * re-read and swapped in one step; a file that fails to parse keeps the
   * last good catalogs. Default `false`.
   */
  watch?: boolean;
}
