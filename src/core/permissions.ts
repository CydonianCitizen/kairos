import { randomUUID } from 'node:crypto';

export type PermissionMode = 'allow' | 'ask' | 'deny';
export type PermissionKind = 'edits' | 'shell' | 'external';
export interface PermissionRule { kind: PermissionKind; mode: PermissionMode; pattern: string }
export type PermissionRules = Partial<Record<PermissionKind, PermissionMode>> & { rules?: PermissionRule[] };
export interface PermissionMetadata { paths?: string[]; command?: string; tools?: string[] }
export interface ApprovalRequest {
  id: string;
  kind: PermissionKind;
  tool: string;
  summary: string;
  preview: string;
}
export type ApprovalHandler = (request: ApprovalRequest, signal?: AbortSignal) => Promise<boolean>;

const KINDS: PermissionKind[] = ['edits', 'shell', 'external'];
const MODES: PermissionMode[] = ['allow', 'ask', 'deny'];
const MAX_RULES = 128;
const MAX_PATTERN_LENGTH = 512;
const MAX_TARGET_LENGTH = 65536;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizePath(value: string): string | undefined {
  const path = value.replace(/\\/g, '/');
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || /[\x00-\x1f\x7f]/.test(path)) return undefined;
  const segments = path.split('/');
  if (segments.includes('..')) return undefined;
  const normalized = segments.filter(part => part !== '' && part !== '.').join('/');
  return (process.platform === 'win32' ? normalized.toLowerCase() : normalized) || undefined;
}

/** Shared validation keeps settings and SDK policies equally strict without echoing values. */
export function validatePermissionRules(value: unknown, allowUndefined = false): PermissionRules {
  const invalid = () => new Error('Invalid permission rules');
  if (!object(value) || Object.keys(value).some(key => !KINDS.includes(key as PermissionKind) && key !== 'rules')) throw invalid();
  const result: PermissionRules = {};
  for (const kind of KINDS) {
    if (!Object.hasOwn(value, kind) || (allowUndefined && value[kind] === undefined)) continue;
    if (!MODES.includes(value[kind] as PermissionMode)) throw invalid();
    result[kind] = value[kind] as PermissionMode;
  }
  if (Object.hasOwn(value, 'rules') && !(allowUndefined && value.rules === undefined)) {
    if (!Array.isArray(value.rules) || value.rules.length > MAX_RULES) throw invalid();
    result.rules = Array.from(value.rules, rule => {
      if (!object(rule) || Object.keys(rule).length !== 3 || Object.keys(rule).some(key => !['kind', 'mode', 'pattern'].includes(key))
        || !KINDS.includes(rule.kind as PermissionKind) || !MODES.includes(rule.mode as PermissionMode)
        || typeof rule.pattern !== 'string' || !rule.pattern.trim() || rule.pattern.length > MAX_PATTERN_LENGTH || rule.pattern.includes('\0')) throw invalid();
      const kind = rule.kind as PermissionKind;
      let pattern = rule.pattern;
      if (kind === 'edits') {
        const normalized = normalizePath(pattern);
        if (!normalized || /[\[\]{}]/.test(normalized) || normalized.split('/').some(part => part.includes('**') && part !== '**')) throw invalid();
        pattern = normalized;
      } else if (kind === 'external') {
        if (!/^[\w:./*?@-]+$/.test(pattern)) throw invalid();
      } else {
        if (/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(pattern)) throw invalid();
        pattern = pattern.replace(/\r\n/g, '\n');
      }
      return { kind, mode: rule.mode as PermissionMode, pattern };
    });
  }
  return result;
}

/** Anchored glob matching; no regular expression backtracking on untrusted commands. */
function matchesGlob(pattern: string, target: string): boolean {
  let p = 0; let t = 0; let star = -1; let retry = 0;
  while (t < target.length) {
    if (pattern[p] === '*') { star = p++; retry = t; }
    else if (pattern[p] === '?' || pattern[p] === target[t]) { p++; t++; }
    else if (star !== -1) { p = star + 1; t = ++retry; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

function matchesPath(pattern: string, target: string): boolean {
  const parts = pattern.split('/'); const segments = target.split('/');
  // Work backwards so ** can match zero or more complete directory segments.
  let next = Array<boolean>(segments.length + 1).fill(false);
  next[segments.length] = true;
  for (let p = parts.length - 1; p >= 0; p--) {
    const current = Array<boolean>(segments.length + 1).fill(false);
    for (let t = segments.length; t >= 0; t--) {
      current[t] = parts[p] === '**' ? next[t]! || (t < segments.length && current[t + 1]!)
        : t < segments.length && matchesGlob(parts[p]!, segments[t]!) && next[t + 1]!;
    }
    next = current;
  }
  return next[0]!;
}

export class PermissionError extends Error {
  constructor(readonly code: 'permission_denied' | 'approval_required', message: string) { super(message); }
}

/** Policy belongs to the host; model instructions cannot grant permission. */
export class PermissionGate {
  private readonly rules: PermissionRules;
  constructor(rules: PermissionRules = {}, private handler?: ApprovalHandler) {
    this.rules = validatePermissionRules(rules);
  }
  mode(kind: PermissionKind, metadata?: PermissionMetadata): PermissionMode {
    const fallback = this.rules[kind] ?? 'allow';
    if (fallback === 'deny' || metadata === undefined) return fallback;
    if (!object(metadata)) return 'deny';
    const raw: unknown = kind === 'edits' ? metadata.paths : kind === 'external' ? metadata.tools
      : metadata.command === undefined ? undefined : [metadata.command];
    if (raw === undefined) return fallback;
    if (!Array.isArray(raw) || raw.length > 1000) return 'deny';
    let mode: PermissionMode = 'allow';
    for (const value of raw) {
      if (typeof value !== 'string' || !value || value.length > MAX_TARGET_LENGTH || value.includes('\0')) return 'deny';
      const target = kind === 'edits' ? normalizePath(value) : kind === 'shell' ? value.replace(/\r\n/g, '\n')
        : /^[\w:./@-]+$/.test(value) ? value : undefined;
      if (target === undefined) return 'deny';
      let matched: PermissionMode | undefined;
      for (const rule of this.rules.rules ?? []) {
        if (rule.kind !== kind || !(kind === 'edits' ? matchesPath(rule.pattern, target) : matchesGlob(rule.pattern, target))) continue;
        // Partial allow globs cover plain arguments; shell syntax needs an exact policy or explicit '*'.
        if (kind === 'shell' && rule.mode === 'allow' && rule.pattern !== '*' && rule.pattern !== target
          && /[*?]/.test(rule.pattern) && /[;&|<>`$\r\n]/.test(target)) continue;
        if (rule.mode === 'deny') return 'deny';
        if (matched !== 'ask') matched = rule.mode;
      }
      if ((matched ?? fallback) === 'ask') mode = 'ask';
    }
    return raw.length ? mode : fallback;
  }
  isAllowed(kind: PermissionKind, metadata?: PermissionMetadata): boolean { return this.mode(kind, metadata) === 'allow'; }
  setHandler(handler?: ApprovalHandler): void { this.handler = handler; }
  async authorize(kind: PermissionKind, tool: string, summary: string, preview: string, signal?: AbortSignal, metadata?: PermissionMetadata): Promise<void> {
    signal?.throwIfAborted();
    const mode = this.mode(kind, metadata);
    if (mode === 'allow') return;
    if (mode === 'deny') throw new PermissionError('permission_denied', `Permission denied for ${tool} (${kind}).`);
    if (!this.handler) throw new PermissionError('approval_required', `Approval required for ${tool}. This host has no interactive approval handler; configure permissions explicitly or use the interactive CLI.`);
    const request: ApprovalRequest = { id: randomUUID(), kind, tool, summary, preview };
    let abort: (() => void) | undefined;
    const decision = Promise.resolve().then(() => this.handler!(request, signal));
    try {
      const accepted = signal ? await Promise.race([decision, new Promise<boolean>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      })]) : await decision;
      signal?.throwIfAborted();
      if (accepted !== true) throw new PermissionError('permission_denied', `User denied ${tool}.`);
    } finally { if (abort) signal?.removeEventListener('abort', abort); }
  }
}
