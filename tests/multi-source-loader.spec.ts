import {
  I18nLoader,
  MultiSourceI18nLoader,
  type I18nCatalogs,
} from '../lib/index.js';

class StubLoader extends I18nLoader {
  constructor(protected readonly catalogs: I18nCatalogs) {
    super();
  }

  async load(): Promise<I18nCatalogs> {
    return this.catalogs;
  }
}

class WatchableLoader extends StubLoader {
  readonly watchers: Array<(catalogs: I18nCatalogs) => void> = [];
  readonly stop = vi.fn();

  watch(onChange: (catalogs: I18nCatalogs) => void): () => void {
    this.watchers.push(onChange);
    return this.stop;
  }

  /** Simulates a change in the underlying source. */
  emit(): void {
    this.watchers.forEach((onChange) => onChange(this.catalogs));
  }
}

class FailingLoader extends I18nLoader {
  async load(): Promise<I18nCatalogs> {
    throw new Error('boom');
  }
}

describe('MultiSourceI18nLoader', () => {
  const multi = (...catalogs: I18nCatalogs[]) =>
    new MultiSourceI18nLoader({
      loaders: catalogs.map((catalog) => new StubLoader(catalog)),
    });

  it('fails when the loaders list is empty', () => {
    expect(() => new MultiSourceI18nLoader({ loaders: [] })).toThrow(
      'MultiSourceI18nLoader: the loaders list cannot be empty.',
    );
  });

  it('returns the catalogs of a single loader unchanged', async () => {
    const catalogs: I18nCatalogs = {
      en: { hello: 'Hello', nested: { a: '1' } },
    };
    expect(await multi(catalogs).load()).toEqual(catalogs);
  });

  it('keeps locales that exist in only one loader', async () => {
    expect(
      await multi(
        { en: { hello: 'Hello' } },
        { fr: { hello: 'Bonjour' } },
      ).load(),
    ).toEqual({
      en: { hello: 'Hello' },
      fr: { hello: 'Bonjour' },
    });
  });

  it('lets later loaders override earlier ones', async () => {
    expect(
      await multi(
        { en: { hello: 'Hello', bye: 'Bye' } },
        { en: { hello: 'Hi' } },
      ).load(),
    ).toEqual({
      en: { hello: 'Hi', bye: 'Bye' },
    });
  });

  it('merges nested objects recursively', async () => {
    const result = await multi(
      { en: { a: { x: '1', y: '2' }, b: { c: { d: '1' } } } },
      { en: { a: { y: '3', z: '4' }, b: { c: { e: '2' } } } },
    ).load();
    expect(result).toEqual({
      en: { a: { x: '1', y: '3', z: '4' }, b: { c: { d: '1', e: '2' } } },
    });
  });

  it('replaces a value when the types differ', async () => {
    const result = await multi(
      { en: { a: { x: '1' }, b: 'text' } },
      { en: { a: 'now a string', b: { y: '2' } } },
    ).load();
    expect(result).toEqual({ en: { a: 'now a string', b: { y: '2' } } });
  });

  it('merges more than two loaders in order', async () => {
    const result = await multi(
      { en: { a: '1', b: '1', c: '1' } },
      { en: { b: '2', c: '2' } },
      { en: { c: '3' } },
    ).load();
    expect(result).toEqual({ en: { a: '1', b: '2', c: '3' } });
  });

  it('does not mutate the catalogs returned by the loaders', async () => {
    const first: I18nCatalogs = { en: { a: { x: '1' } } };
    const second: I18nCatalogs = { en: { a: { y: '2' } } };
    await multi(first, second).load();
    expect(first).toEqual({ en: { a: { x: '1' } } });
    expect(second).toEqual({ en: { a: { y: '2' } } });
  });

  it('fails when any loader fails', async () => {
    const loader = new MultiSourceI18nLoader({
      loaders: [new StubLoader({ en: { a: '1' } }), new FailingLoader()],
    });
    await expect(loader.load()).rejects.toThrow('boom');
  });

  describe('keys named like Object.prototype members', () => {
    it('keeps a __proto__ key as a namespace without polluting prototypes', async () => {
      const withProto: I18nCatalogs = JSON.parse(
        '{"en":{"__proto__":{"polluted":"yes"},"ok":"fine"}}',
      );
      const result = await multi(
        { en: { ok: 'old', extra: 'x' } },
        withProto,
      ).load();

      expect(Object.keys(result.en).sort()).toEqual([
        '__proto__',
        'extra',
        'ok',
      ]);
      expect(
        Object.getOwnPropertyDescriptor(result.en, '__proto__')?.value,
      ).toEqual({ polluted: 'yes' });
      expect(Object.getPrototypeOf(result.en)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(result.en.ok).toBe('fine');
    });

    it('merges a __proto__ namespace defined by several loaders', async () => {
      const first: I18nCatalogs = JSON.parse('{"en":{"__proto__":{"a":"1"}}}');
      const second: I18nCatalogs = JSON.parse('{"en":{"__proto__":{"b":"2"}}}');
      const result = await multi(first, second).load();

      expect(
        Object.getOwnPropertyDescriptor(result.en, '__proto__')?.value,
      ).toEqual({ a: '1', b: '2' });
      expect(Object.getPrototypeOf(result.en)).toBe(Object.prototype);
    });

    it('keeps a __proto__ locale without polluting prototypes', async () => {
      const withProtoLocale: I18nCatalogs = JSON.parse(
        '{"__proto__":{"a":"b"}}',
      );
      const result = await multi(withProtoLocale, { en: { a: '1' } }).load();

      expect(Object.keys(result).sort()).toEqual(['__proto__', 'en']);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>).a).toBeUndefined();
    });
  });

  describe('watch', () => {
    it('watches every loader and stops all of them', () => {
      const first = new WatchableLoader({});
      const second = new WatchableLoader({});

      const stopAll = new MultiSourceI18nLoader({
        loaders: [first, second],
      }).watch(() => {});

      expect(first.watchers).toHaveLength(1);
      expect(second.watchers).toHaveLength(1);
      expect(first.stop).not.toHaveBeenCalled();
      expect(second.stop).not.toHaveBeenCalled();

      stopAll();

      expect(first.stop).toHaveBeenCalledTimes(1);
      expect(second.stop).toHaveBeenCalledTimes(1);
    });

    it('skips loaders that cannot watch', () => {
      const watchable = new WatchableLoader({});

      const stopAll = new MultiSourceI18nLoader({
        loaders: [new StubLoader({}), watchable],
      }).watch(() => {});

      expect(watchable.watchers).toHaveLength(1);
      expect(() => stopAll()).not.toThrow();
      expect(watchable.stop).toHaveBeenCalledTimes(1);
    });

    it('returns a stop function even when nothing is watched', () => {
      const stop = multi({ en: { a: '1' } }).watch(() => {
        throw new Error('never called');
      });
      expect(stop).toBeTypeOf('function');
      expect(() => stop()).not.toThrow();
    });
  });
});
