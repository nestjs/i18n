/** A header or query value repeated as an array counts by its first entry; an empty string counts as none (internal). */
export function first(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * The query string of a raw request URL, as an object (internal). A repeated
 * parameter keeps its first value, as `QueryLocaleResolver` reads the first
 * entry of the arrays Express and Fastify parse: `?lang=pl&lang=de` → `pl`.
 */
export function queryOf(url: unknown): Record<string, string> {
  if (typeof url !== 'string') {
    return {};
  }

  const start = url.indexOf('?');
  // Null prototype: a `__proto__` parameter is an ordinary key.
  const query: Record<string, string> = Object.create(null);
  if (start === -1) {
    return query;
  }

  for (const [name, value] of new URLSearchParams(url.slice(start))) {
    if (!Object.hasOwn(query, name)) {
      query[name] = value;
    }
  }
  return query;
}
