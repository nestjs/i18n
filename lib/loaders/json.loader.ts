import { Logger } from '@nestjs/common';
import { watch as fsWatch, type Dirent, type FSWatcher } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type {
  I18nCatalog,
  I18nCatalogs,
} from '../interfaces/i18n-module-options.interface.js';
import type {
  JsonI18nLoaderOptions,
} from '../interfaces/json-loader-options.interface.js';
import { I18nLoader } from './i18n.loader.js';

/** Quiet period after a file change before the catalogs are re-read. */
const WATCH_DEBOUNCE = 100;

/**
 * Loads `<path>/<locale>/**\/*.json`. Each file becomes a namespace named
 * after the file (`en/users.json` → `users.*`); sub-directories nest further.
 * Symbolic links are followed. Hidden entries (names starting with `.`) are
 * skipped: editor lock files, macOS metadata, Kubernetes ConfigMap internals.
 */
export class JsonI18nLoader extends I18nLoader {
  private readonly logger = new Logger('JsonI18nLoader');

  constructor(readonly options: Readonly<JsonI18nLoaderOptions>) {
    super();
  }

  async load(): Promise<I18nCatalogs> {
    const catalogs: I18nCatalogs = {};
    const root = await realpath(this.options.path).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') {
        throw err;
      }
      throw new Error(
        `JsonI18nLoader: the catalog directory ${this.options.path} doesn't exist (ENOENT). ` +
          'When it is in the build output, list the catalogs in the "assets" of nest-cli.json.',
      );
    });

    for (const entry of await readdir(this.options.path, { withFileTypes: true })) {
      const full = join(this.options.path, entry.name);
      if (!entry.name.startsWith('.') && (await kindOf(entry, full)) === 'directory') {
        define(catalogs, entry.name, await readTree(full, [root]));
      }
    }

    return catalogs;
  }

  watch(onChange: (catalogs: I18nCatalogs) => void): () => void {
    if (!this.options.watch) {
      return () => {};
    }
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    // Serializes reloads: a change during a reload schedules one more pass.
    let running = false;
    let pending = false;

    const reload = async (): Promise<void> => {
      if (running) {
        pending = true;
        return;
      }

      running = true;
      try {
        const next = await this.load();
        if (!closed) {
          onChange(next);
        }
      } catch (err) {
        this.logger.error(
          `Keeping the previous translations; reload failed: ${(err as Error).message}`,
        );
      } finally {
        running = false;
      }

      if (pending && !closed) {
        pending = false;
        await reload();
      }
    };

    const watcher: FSWatcher = fsWatch(
      this.options.path,
      { recursive: true, persistent: false },
      () => {
        clearTimeout(timer);
        // Like the watcher, a pending reload doesn't keep the process alive.
        timer = setTimeout(() => void reload(), WATCH_DEBOUNCE).unref();
      },
    );
    watcher.on('error', (err) =>
      this.logger.error(`Watcher error: ${err.message}`),
    );

    return () => {
      closed = true;
      clearTimeout(timer);
      watcher.close();
    };
  }
}

/**
 * Reads a namespace directory. `ancestors` are the real paths of the
 * directories above it, to stop a symbolic link that points back up.
 */
async function readTree(dir: string, ancestors: string[]): Promise<I18nCatalog> {
  const real = await realpath(dir);
  if (ancestors.includes(real)) {
    throw new Error(`${dir}: symbolic link cycle`);
  }

  const tree: I18nCatalog = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }

    const full = join(dir, entry.name);
    const kind = await kindOf(entry, full);
    if (kind === 'directory') {
      define(tree, entry.name, await readTree(full, [...ancestors, real]));
    } else if (kind === 'file' && extname(entry.name) === '.json') {
      try {
        define(tree, basename(entry.name, '.json'), JSON.parse(await readFile(full, 'utf8')));
      } catch (err) {
        throw new Error(`${full}: ${(err as Error).message}`);
      }
    }
  }
  return tree;
}

/** What an entry is, following symbolic links. A dangling link is neither. */
async function kindOf(entry: Dirent, full: string): Promise<'directory' | 'file' | undefined> {
  if (entry.isDirectory()) {
    return 'directory';
  }
  if (entry.isFile()) {
    return 'file';
  }
  if (!entry.isSymbolicLink()) {
    return undefined;
  }

  try {
    const target = await stat(full);
    return target.isDirectory() ? 'directory' : target.isFile() ? 'file' : undefined;
  } catch {
    return undefined;
  }
}

/** Sets a key even when it's named like an `Object.prototype` accessor (`__proto__`). */
function define(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
