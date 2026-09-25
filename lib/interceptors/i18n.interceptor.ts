import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { from, Observable, switchMap } from 'rxjs';
import { changeLocale, i18nStorage, type I18nStore } from '../context/i18n.storage.js';
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
 * outside Nest's middleware. Interceptors run after guards, so guards on those
 * paths don't see the locale
 * (https://docs.nestjs.com/application/i18n#microservices-and-websocket-gateways).
 * Where the middleware has entered the context, runs the `afterGuards`
 * resolvers it left (internal).
 */
@Injectable()
export class I18nInterceptor implements NestInterceptor {
  constructor(
    private readonly resolution: LocaleResolution,
    private readonly i18n: I18nService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const store = i18nStorage.getStore();
    if (!store) {
      return from(this.resolution.resolve(toResolverInput(context))).pipe(
        switchMap((locale) => within({ locale, service: this.i18n }, next)),
      );
    }

    const pending = store.pending;
    if (!pending) {
      return next.handle();
    }

    pending.settled ??= this.settle(store, pending, context);
    return from(pending.settled).pipe(switchMap(() => within(store, next)));
  }

  private async settle(
    store: I18nStore,
    pending: NonNullable<I18nStore['pending']>,
    context: ExecutionContext,
  ) {
    const locale = await this.resolution.first(pending.resolvers, toResolverInput(context));

    // `setLocale()` may have settled it meanwhile: an explicit choice wins.
    if (store.pending !== pending) {
      return;
    }
    store.pending = undefined;
    if (locale) {
      changeLocale(store, locale);
    }
  }
}

/** Subscribes to the handler inside `store`, so everything it awaits sees the locale. */
function within(store: I18nStore, next: CallHandler): Observable<unknown> {
  return new Observable((subscriber) =>
    i18nStorage.run(store, () => next.handle().subscribe(subscriber)),
  );
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
