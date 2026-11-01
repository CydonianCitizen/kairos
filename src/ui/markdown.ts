/**
 * Lightweight, zero-dependency ANSI terminal markdown formatter.
 * Formats inline bold, italic, code, headers, quotes, lists, and codeblocks
 * into ANSI escape codes supported by standard terminal emulators and React Ink.
 */

// ANSI Escape Codes
const BOLD_ON = '\x1b[1m';
const BOLD_OFF = '\x1b[22m';
const ITALIC_ON = '\x1b[3m';
const ITALIC_OFF = '\x1b[23m';

// Palette matching theme.ts
const COLOR_BRAND = '\x1b[38;2;229;192;123m';      // #E5C07B Gold
const COLOR_ACCENT = '\x1b[38;2;209;154;102m';     // #D19A66 Bronze
const COLOR_CODE = '\x1b[38;2;86;182;194m';        // #56B6C2 Cyan
const COLOR_MUTED = '\x1b[38;2;92;99;112m';        // #5C6370 Gray
const COLOR_OFF = '\x1b[39m';

/** Formats inline markdown elements (bold, italic, code, links). */
export function formatInlineMarkdown(text: string): string {
  if (!text) return '';

  return text
    // Inline code: `code`
    .replace(/`([^`\n]+)`/g, `${COLOR_CODE}$1${COLOR_OFF}`)
    // Bold: **text** or __text__
    .replace(/\*\*([^*\n]+)\*\*/g, `${BOLD_ON}$1${BOLD_OFF}`)
    .replace(/__([^_\n]+)__/g, `${BOLD_ON}$1${BOLD_OFF}`)
    // Italic: *text* or _text_ (excluding underscore identifiers like foo_bar_baz)
    .replace(/(^|[^\w*])\*([^*\n]+)\*([^\w*]|$)/g, `$1${ITALIC_ON}$2${ITALIC_OFF}$3`)
    .replace(/(^|[^\w_])_([^_\n]+)_([^\w_]|$)/g, `$1${ITALIC_ON}$2${ITALIC_OFF}$3`)
    // Strikethrough: ~~text~~
    .replace(/~~([^~\n]+)~~/g, `\x1b[9m$1\x1b[29m`)
    // Markdown link: [text](url) -> text (url)
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, `${COLOR_CODE}$1${COLOR_OFF} ${COLOR_MUTED}($2)${COLOR_OFF}`);
}

/** Formats full markdown document (fenced blocks, headers, quotes, lists). */
export function formatMarkdown(markdown: string): string {
  if (!markdown) return '';

  const lines = markdown.split(/\r?\n/);
  const formatted: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Fenced code blocks ```
    const codeMatch = line.match(/^```(\w*)/);
    if (codeMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = codeMatch[1] || '';
        const langLabel = codeBlockLang ? ` [${codeBlockLang}]` : '';
        formatted.push(`${COLOR_MUTED}┌──${langLabel}──${'─'.repeat(Math.max(0, 30 - langLabel.length))}${COLOR_OFF}`);
      } else {
        inCodeBlock = false;
        codeBlockLang = '';
        formatted.push(`${COLOR_MUTED}└──${'─'.repeat(30)}${COLOR_OFF}`);
      }
      continue;
    }

    if (inCodeBlock) {
      // Inside code block: dim code styling
      formatted.push(`${COLOR_MUTED}│${COLOR_OFF} ${COLOR_CODE}${line}${COLOR_OFF}`);
      continue;
    }

    // Horizontal rule: ---, ***, ___
    if (/^(?:---|\*\*\*|___)\s*$/.test(line)) {
      formatted.push(`${COLOR_MUTED}────────────────────────────────────────${COLOR_OFF}`);
      continue;
    }

    // Headers: # Header
    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      const level = headerMatch[1]!.length;
      const title = formatInlineMarkdown(headerMatch[2]!);
      if (level === 1) {
        formatted.push(`${BOLD_ON}${COLOR_BRAND}# ${title}${COLOR_OFF}${BOLD_OFF}`);
      } else if (level === 2) {
        formatted.push(`${BOLD_ON}${COLOR_ACCENT}## ${title}${COLOR_OFF}${BOLD_OFF}`);
      } else {
        formatted.push(`${BOLD_ON}${COLOR_CODE}### ${title}${COLOR_OFF}${BOLD_OFF}`);
      }
      continue;
    }

    // Blockquote: > text
    const quoteMatch = line.match(/^>\s*(.*)$/);
    if (quoteMatch) {
      const content = formatInlineMarkdown(quoteMatch[1]!);
      formatted.push(`${COLOR_MUTED}│${COLOR_OFF} ${ITALIC_ON}${content}${ITALIC_OFF}`);
      continue;
    }

    // Unordered list: - item, * item, + item
    const listMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (listMatch) {
      const indent = listMatch[1]!;
      const content = formatInlineMarkdown(listMatch[2]!);
      formatted.push(`${indent}${COLOR_BRAND}•${COLOR_OFF} ${content}`);
      continue;
    }

    // Numbered list: 1. item
    const numListMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (numListMatch) {
      const indent = numListMatch[1]!;
      const num = numListMatch[2]!;
      const content = formatInlineMarkdown(numListMatch[3]!);
      formatted.push(`${indent}${COLOR_ACCENT}${num}.${COLOR_OFF} ${content}`);
      continue;
    }

    // Regular line with inline formatting
    formatted.push(formatInlineMarkdown(line));
  }

  return formatted.join('\n');
}
