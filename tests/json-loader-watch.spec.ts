import { Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { watch } from 'node:fs';
import { JsonI18nLoader, type I18nCatalogs } from '../lib/index.js';

// The file watcher is replaced, so changes and timing are driven by the test.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  watch: vi.fn(),
}));

class FakeWatcher extends EventEmitter {
  close = vi.fn();
}

/** A JsonI18nLoader whose reads the test settles one by one. */
class ControlledLoader extends JsonI18nLoader {
  readonly reads: { resolve: (catalogs: I18nCatalogs) => void; reject: (err: Error) => void }[] = [];

  load() {
    return new Promise<I18nCatalogs>((resolve, reject) => this.reads.push({ resolve, reject }));
  }
}

describe('JsonI18nLoader.watch()', () => {
  let watcher: FakeWatcher;
  let change: () => void;
  let loader: ControlledLoader;
  let onChange: ReturnType<typeof vi.fn<(catalogs: I18nCatalogs) => void>>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    watcher = new FakeWatcher();
    vi.mocked(watch).mockReset().mockImplementation(((_path: string, _options: object, listener: () => void) => {
      change = listener;
      return watcher;
    }) as unknown as typeof watch);
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    loader = new ControlledLoader({ path: '/srv/i18n', watch: true });
    onChange = vi.fn();
  });
  afterEach(() => {
    error.mockRestore();
    vi.useRealTimers();
  });

  const catalogs = (hi: string) => ({ en: { hi } });

  it('watches the directory recursively without keeping the process alive', () => {
    loader.watch(onChange);
    expect(watch).toHaveBeenCalledWith('/srv/i18n', { recursive: true, persistent: false }, expect.any(Function));
  });

  it('re-reads once, 100 ms after the last of a burst of changes', async () => {
    loader.watch(onChange);
    change();
    await vi.advanceTimersByTimeAsync(60);
    change();
    await vi.advanceTimersByTimeAsync(60);
    change();
    await vi.advanceTimersByTimeAsync(99);
    expect(loader.reads).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(loader.reads).toHaveLength(1);
    loader.reads[0].resolve(catalogs('Hello'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(catalogs('Hello'));
  });

  it('runs one read at a time, and one more after it for the changes made meanwhile', async () => {
    loader.watch(onChange);
    change();
    await vi.advanceTimersByTimeAsync(100);
    change();
    await vi.advanceTimersByTimeAsync(100);
    change();
    await vi.advanceTimersByTimeAsync(100);
    expect(loader.reads).toHaveLength(1);

    loader.reads[0].resolve(catalogs('first'));
    await vi.advanceTimersByTimeAsync(0);
    expect(loader.reads).toHaveLength(2);
    loader.reads[1].resolve(catalogs('second'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange.mock.calls).toEqual([[catalogs('first')], [catalogs('second')]]);
    expect(loader.reads).toHaveLength(2);
  });

  it('logs a failed read, keeps the catalogs, and reads again on the next change', async () => {
    loader.watch(onChange);
    change();
    await vi.advanceTimersByTimeAsync(100);
    loader.reads[0].reject(new Error('/srv/i18n/en/users.json: Unexpected end of JSON input'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      'Keeping the previous translations; reload failed: /srv/i18n/en/users.json: Unexpected end of JSON input',
    );

    change();
    await vi.advanceTimersByTimeAsync(100);
    loader.reads[1].resolve(catalogs('fixed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(catalogs('fixed'));
  });

  it('logs watcher errors', () => {
    loader.watch(onChange);
    watcher.emit('error', new Error('EMFILE: too many open files'));
    expect(error).toHaveBeenCalledWith('Watcher error: EMFILE: too many open files');
  });

  it('stop() closes the watcher and drops a pending change', async () => {
    const stop = loader.watch(onChange);
    change();
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(watcher.close).toHaveBeenCalledOnce();
    expect(loader.reads).toHaveLength(0);
  });

  it('stop() during a read drops its result and the changes queued behind it', async () => {
    const stop = loader.watch(onChange);
    change();
    await vi.advanceTimersByTimeAsync(100);
    change();
    await vi.advanceTimersByTimeAsync(100);
    stop();
    loader.reads[0].resolve(catalogs('late'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).not.toHaveBeenCalled();
    expect(loader.reads).toHaveLength(1);
  });
});
