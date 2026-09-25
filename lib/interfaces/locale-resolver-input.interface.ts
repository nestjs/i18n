import type { ExecutionContext } from '@nestjs/common';

/**
 * What a resolver sees. `headers` and `query` come from the HTTP request; for
 * WebSockets, from the handshake (socket.io's, or the upgrade request stored on
 * `client.request`); for GraphQL subscriptions, from the upgrade request.
 * Microservices have neither: read the message through `executionContext`.
 */
export interface LocaleResolverInput {
  /** Request headers, with lower-cased names. */
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  /**
   * Set when the locale is resolved after guards: for `afterGuards`
   * resolvers, and for every resolver where the HTTP middleware doesn't run
   * (microservices, WebSocket gateways, GraphQL subscriptions, and GraphQL
   * drivers mounted outside Nest's middleware).
   */
  executionContext?: ExecutionContext;
}
