import { readFile, realpath, lstat } from 'node:fs/promises';
import { extname, join, relative, resolve, isAbsolute, posix } from 'node:path';
import fg from 'fast-glob';
import ignore, { type Ignore } from 'ignore';

const EXCLUDED = [
  '**/.git/**', '**/node_modules/**', '**/dist/**', '**/build/**',
  '**/coverage/**', '**/target/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**'
];

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar', '.bz2', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.obj', '.o', '.a', '.lib',
  '.wasm', '.pyc', '.class', '.jar',
  '.mp3', '.mp4', '.wav', '.mov', '.avi', '.mkv', '.webm',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.sqlite', '.db', '.lockb'
]);

export interface IgnoreScope {
  directory: string;
  rules: Ignore;
}

export function ignored(path: string, scopes: IgnoreScope[]): boolean {
  const parts = path.split('/');
  for (let length = 1; length <= parts.length; length++) {
    const prefix = parts.slice(0, length).join('/') + (length < parts.length ? '/' : '');
    let blocked = false;
    for (const scope of scopes) {
      if (scope.directory && !prefix.startsWith(`${scope.directory}/`)) continue;
      const local = scope.directory ? prefix.slice(scope.directory.length + 1) : prefix;
      if (!local) continue;
      const match = scope.rules.test(local);
      if (match.ignored) blocked = true;
      if (match.unignored) blocked = false;
    }
    if (blocked) return true;
  }
  return false;
}

export interface FindFilesOptions {
  pattern?: string;
  patterns?: string[];
  directory?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface FindFilesResult {
  files: string[];
  totalMatches: number;
  truncated: boolean;
}

export interface SearchTextOptions {
  query: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  filePattern?: string;
  directory?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface TextMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchTextResult {
  matches: TextMatch[];
  totalMatches: number;
  truncated: boolean;
}

export class SearchTools {
  constructor(readonly workspace: string) {}

  private async getRootAndTarget(directory?: string): Promise<{ root: string; target: string; prefix: string }> {
    const root = await realpath(this.workspace);
    if (!directory || directory === '.' || directory === './') {
      return { root, target: root, prefix: '' };
    }
    const normalized = posix.normalize(directory.replaceAll('\\', '/')).replace(/\/$/, '');
    if (normalized.startsWith('../') || normalized === '..' || isAbsolute(normalized)) {
      throw new Error('Directory must be relative to the workspace and not escape it');
    }
    const resolved = resolve(root, normalized);
    const rel = relative(root, resolved);
    if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
      throw new Error('Directory must be within the workspace');
    }
    return { root, target: resolved, prefix: normalized };
  }

  private async loadIgnoreScopes(root: string, signal?: AbortSignal): Promise<IgnoreScope[]> {
    const scopes: IgnoreScope[] = [];
    const globOptions = { cwd: root, dot: true, onlyFiles: true, followSymbolicLinks: false, ignore: EXCLUDED };
    const safe = async (p: string): Promise<boolean> => {
      const absolute = join(root, p);
      if ((await lstat(absolute)).isSymbolicLink()) return false;
      const rel = relative(root, await realpath(absolute));
      return rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel);
    };
    const ignoreFiles = (await fg('**/.gitignore', globOptions)).sort(
      (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)
    );
    for (const path of ignoreFiles) {
      signal?.throwIfAborted();
      try {
        if (ignored(path, scopes) || !await safe(path)) continue;
        const directory = posix.dirname(path);
        const content = await readFile(join(root, path), 'utf8');
        scopes.push({
          directory: directory === '.' ? '' : directory,
          rules: ignore().add(content)
        });
      } catch {
        // ignore unreadable .gitignore
      }
    }
    return scopes;
  }

  async find_files(options: FindFilesOptions = {}): Promise<FindFilesResult> {
    options.signal?.throwIfAborted();
    const { root, target, prefix } = await this.getRootAndTarget(options.directory);
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));

    let patterns: string[] = [];
    if (options.patterns && options.patterns.length > 0) {
      patterns = options.patterns;
    } else if (options.pattern) {
      patterns = [options.pattern];
    } else {
      patterns = ['**/*'];
    }

    const scopes = await this.loadIgnoreScopes(root, options.signal);
    const globOptions = {
      cwd: target,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: EXCLUDED
    };

    const foundSet = new Set<string>();
    for (const pat of patterns) {
      options.signal?.throwIfAborted();
      const matches = await fg(pat, globOptions);
      for (const m of matches) {
        const fullRel = prefix ? posix.join(prefix, m) : m;
        if (!ignored(fullRel, scopes)) {
          foundSet.add(fullRel);
        }
      }
    }

    const allFiles = [...foundSet].sort();
    const totalMatches = allFiles.length;
    const truncated = totalMatches > limit;
    return {
      files: allFiles.slice(0, limit),
      totalMatches,
      truncated
    };
  }

  async search_text(options: SearchTextOptions): Promise<SearchTextResult> {
    options.signal?.throwIfAborted();
    if (!options.query || typeof options.query !== 'string') {
      throw new Error('Expected a non-empty query string');
    }
    const limit = Math.max(1, Math.min(200, options.limit ?? 100));
    const { root, target, prefix } = await this.getRootAndTarget(options.directory);
    const scopes = await this.loadIgnoreScopes(root, options.signal);

    let regex: RegExp;
    if (options.isRegex) {
      try {
        regex = new RegExp(options.query, options.caseSensitive ? 'g' : 'gi');
      } catch (e) {
        throw new Error(`Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      const escaped = options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(escaped, options.caseSensitive ? 'g' : 'gi');
    }

    let pattern = options.filePattern ?? '**/*';
    if (!pattern.includes('/')) {
      pattern = `**/${pattern}`;
    }
    const globOptions = {
      cwd: target,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: EXCLUDED
    };

    const candidateFiles = (await fg(pattern, globOptions)).sort();
    const matches: TextMatch[] = [];
    let totalMatches = 0;
    let truncated = false;

    for (const rel of candidateFiles) {
      if (truncated) break;
      options.signal?.throwIfAborted();
      const workspaceRel = prefix ? posix.join(prefix, rel) : rel;
      if (ignored(workspaceRel, scopes)) continue;

      const ext = extname(rel).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;

      const fullPath = join(target, rel);
      try {
        const info = await lstat(fullPath);
        if (info.size > 1024 * 1024) continue;

        const content = await readFile(fullPath, 'utf8');
        if (content.slice(0, 512).includes('\0')) continue;

        const lines = content.split(/\r?\n/);
        for (let row = 0; row < lines.length; row++) {
          const line = lines[row]!;
          regex.lastIndex = 0;
          if (regex.test(line)) {
            totalMatches++;
            if (matches.length < limit) {
              const text = line.length > 300 ? `${line.slice(0, 300)}...` : line;
              matches.push({
                path: workspaceRel,
                line: row + 1,
                text: text.trimEnd()
              });
            } else {
              truncated = true;
              break;
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return {
      matches,
      totalMatches,
      truncated
    };
  }
}
