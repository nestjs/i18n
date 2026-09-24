/**
 * Quotes a key or locale for a log line or an error message (internal).
 * Control characters are escaped, so a key built from request data can't
 * forge log lines.
 */
export function quote(value: string): string {
  return JSON.stringify(value);
}
