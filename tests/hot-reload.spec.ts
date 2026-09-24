import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { I18nModule, I18nService, JsonI18nLoader } from '../lib/index.js';
import { localesPath } from './app.js';

describe('JSON loader hot reload', () => {
  let dir: string;
  let ref: TestingModule;
  let i18n: I18nService;
  const waitOpts = { timeout: 3000, interval: 20 };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nest-i18n-'));
    await cp(localesPath, dir, { recursive: true });
    ref = await Test.createTestingModule({
      imports: [
        I18nModule.forRoot({
          defaultLocale: 'en',
          loader: new JsonI18nLoader({ path: dir, watch: true }),
        }),
      ],
    }).compile();
    await ref.init();
    i18n = ref.get(I18nService);
  });

  afterEach(async () => {
    await ref.close();
    await rm(dir, { recursive: true, force: true });
  });

  const writeUsers = (content: object | string) =>
    writeFile(
      join(dir, 'pl', 'users.json'),
      typeof content === 'string' ? content : JSON.stringify(content),
    );

  it('picks up edited and added translations', async () => {
    expect(i18n.t('users.greeting', { locale: 'pl', args: { name: 'A' } })).toBe('Cześć, A!');
    await writeUsers({ greeting: 'Siema, {name}!', brandNew: 'Nowe' });
    await vi.waitFor(
      () => expect(i18n.t('users.greeting', { locale: 'pl', args: { name: 'A' } })).toBe('Siema, A!'),
      waitOpts,
    );
    expect(i18n.t('users.brandNew', { locale: 'pl' })).toBe('Nowe');
    // other files and locales are untouched
    expect(i18n.t('validation.isEmail', { locale: 'pl', args: { property: 'e' } })).toBe(
      'e musi być poprawnym adresem e-mail',
    );
  });

  it('picks up a new locale directory', async () => {
    await cp(join(dir, 'de'), join(dir, 'fr'), { recursive: true });
    await writeFile(join(dir, 'fr', 'users.json'), JSON.stringify({ greeting: 'Salut, {name}!' }));
    await vi.waitFor(() => expect(i18n.supportedLocales).toContain('fr'), waitOpts);
    expect(i18n.matchLocale('fr-CA')).toBe('fr');
  });

  it('keeps the last good catalog on a parse error and logs it', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      await writeUsers('{ "greeting": "broken", ');
      await vi.waitFor(() => expect(error).toHaveBeenCalled(), waitOpts);
      expect(String(error.mock.calls[0][0])).toMatch(/pl\/users\.json/);
      expect(i18n.t('users.greeting', { locale: 'pl', args: { name: 'A' } })).toBe('Cześć, A!');
      // and recovers once the file is fixed
      await writeUsers({ greeting: 'Naprawione, {name}' });
      await vi.waitFor(
        () => expect(i18n.t('users.greeting', { locale: 'pl', args: { name: 'A' } })).toBe('Naprawione, A'),
        waitOpts,
      );
    } finally {
      error.mockRestore();
    }
  });

  it('rejects a reload that leaves defaultLocale without a catalog', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      await rm(join(dir, 'en'), { recursive: true, force: true });
      await vi.waitFor(() => expect(error).toHaveBeenCalled(), waitOpts);
      expect(String(error.mock.calls[0][0])).toContain(`no catalog for defaultLocale "en"`);
      expect(i18n.t('users.greeting', { args: { name: 'A' } })).toBe('Hello, A!');
    } finally {
      error.mockRestore();
    }
  });

  it('rejects a reload that adds a locale that is not a BCP 47 tag', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      await cp(join(dir, 'de'), join(dir, 'pt_BR'), { recursive: true });
      await vi.waitFor(() => expect(error).toHaveBeenCalled(), waitOpts);
      expect(String(error.mock.calls[0][0])).toContain('"pt_BR", which isn\'t a BCP 47 language tag');
      expect([...i18n.supportedLocales].sort()).toEqual(['de', 'en', 'pl']);
    } finally {
      error.mockRestore();
    }
  });

  it('does not keep the process alive for a pending reload', async () => {
    const original = globalThis.setTimeout;
    const debounces: NodeJS.Timeout[] = [];
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      ms?: number,
    ) => {
      const timer = original(callback, ms);
      if (ms === 100) {
        debounces.push(timer);
      }
      return timer;
    }) as typeof setTimeout);
    try {
      await writeUsers({ greeting: 'Hej, {name}!' });
      await vi.waitFor(() => expect(debounces.length).toBeGreaterThan(0), waitOpts);
      expect(debounces.some((timer) => timer.hasRef())).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('stops watching on shutdown', async () => {
    await ref.close();
    await writeUsers({ greeting: 'After close' });
    await new Promise((r) => setTimeout(r, 200));
    expect(i18n.t('users.greeting', { locale: 'pl', args: { name: 'A' } })).toBe('Cześć, A!');
    // afterEach closes again; make that a no-op
    ref = { close: async () => {} } as TestingModule;
  });
});
