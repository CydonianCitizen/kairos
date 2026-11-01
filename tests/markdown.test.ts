import { describe, it, expect } from 'vitest';
import { formatMarkdown, formatInlineMarkdown } from '../src/ui/markdown.js';

describe('formatInlineMarkdown', () => {
  it('formats bold text with ANSI escape codes', () => {
    const formatted = formatInlineMarkdown('This is **bold** text');
    expect(formatted).toContain('\x1b[1mbold\x1b[22m');
  });

  it('formats italic text with ANSI escape codes', () => {
    const formatted = formatInlineMarkdown('This is *italic* text');
    expect(formatted).toContain('\x1b[3mitalic\x1b[23m');
  });

  it('formats inline code with ANSI cyan', () => {
    const formatted = formatInlineMarkdown('Run `npm test` now');
    expect(formatted).toContain('\x1b[38;2;86;182;194mnpm test\x1b[39m');
  });

  it('does not format identifiers with underscores as italics', () => {
    const formatted = formatInlineMarkdown('const my_var_name = 1;');
    expect(formatted).not.toContain('\x1b[3m');
  });
});

describe('formatMarkdown', () => {
  it('formats headers', () => {
    const formatted = formatMarkdown('# Title\n## Subtitle');
    expect(formatted).toContain('\x1b[1m\x1b[38;2;229;192;123m# Title');
    expect(formatted).toContain('\x1b[1m\x1b[38;2;209;154;102m## Subtitle');
  });

  it('formats lists with styled bullets', () => {
    const formatted = formatMarkdown('- Item 1\n- Item 2');
    expect(formatted).toContain('•');
    expect(formatted).toContain('Item 1');
  });

  it('formats fenced code blocks', () => {
    const formatted = formatMarkdown('```ts\nconst a = 1;\n```');
    expect(formatted).toContain('┌── [ts]');
    expect(formatted).toContain('const a = 1;');
    expect(formatted).toContain('└──');
  });

  it('formats blockquotes', () => {
    const formatted = formatMarkdown('> Note this');
    expect(formatted).toContain('│');
    expect(formatted).toContain('\x1b[3mNote this\x1b[23m');
  });
});
