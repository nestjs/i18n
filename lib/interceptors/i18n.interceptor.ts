import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { from, Observable, switchMap } from 'rxjs';
import { i18nStorage } from '../context/i18n.storage.js';
import { I18nService } from '../i18n.service.js';
import type {
  LocaleResolverInput,
} from '../interfaces/locale-resolver-input.interface.js';
import { LocaleResolution } from '../services/locale-resolution.service.js';
import { queryOf } from '../utils/request.util.js';

/** What the interceptor reads from a request, a handshake or an upgrade request. */
interface RequestLike {
  headers?: LocaleResolverInput['headers'];
  query?: Record<string, unknown>;
  url?: string;
}

/**
 * Enters the locale context where the HTTP middleware doesn't: microservices,
 * WebSocket gateways, GraphQL subscriptions, and GraphQL drivers mounted
 * outside Nest's middleware. A no-op when the context is already entered.
 * Interceptors run after guards, so guards on those paths don't see the
 * locale (internal; see the README's "What works where").
 */
@Injectable()
export class I18nInterceptor implements NestInterceptor {
  constructor(
    private readonly resolution: LocaleResolution,
    private readonly i18n: I18nService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (i18nStorage.getStore()) {
      return next.handle();
    }

    return from(this.resolution.resolve(toResolverInput(context))).pipe(
      switchMap(
        (locale) =>
          new Observable((subscriber) =>
            i18nStorage.run({ locale, service: this.i18n }, () =>
              next.handle().subscribe(subscriber),
            ),
          ),
      ),
    );
  }
}

function toResolverInput(context: ExecutionContext): LocaleResolverInput {
  const request = requestOf(context);
  return {
    headers: request?.headers ?? {},
    query: request?.query ?? queryOf(request?.url),
    executionContext: context,
  };
}

function requestOf(context: ExecutionContext): RequestLike | undefined {
  switch (context.getType<string>()) {
    case 'http':
      return context.switchToHttp().getRequest();
    case 'ws': {
      // socket.io keeps the handshake; the `ws` library keeps nothing, so
      // WsAuthenticator (or the gateway's handleConnection) stores the
      // upgrade request on `client.request`.
      const client = context.switchToWs().getClient();
      return withHeaders(client?.handshake) ?? withHeaders(client?.request);
    }
    case 'graphql': {
      // Resolvers get (root, args, context, info). Apollo puts the HTTP request
      // at `req`, Mercurius at `reply.request`. For graphql-ws subscriptions,
      // the upgrade request is at `extra.request` of graphql-ws's context,
      // which Nest's default context nests under `req`.
      const gql = context.getArgByIndex(2) ?? {};
      return (
        withHeaders(gql.req) ??
        withHeaders(gql.reply?.request) ??
        withHeaders(gql.req?.extra?.request) ??
        withHeaders(gql.extra?.request)
      );
    }
    default:
      return undefined;
  }
}

function withHeaders(value: unknown): RequestLike | undefined {
  return value !== null && typeof value === 'object' && 'headers' in value && value.headers
    ? (value as RequestLike)
    : undefined;
}
