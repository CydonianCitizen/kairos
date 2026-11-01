import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const previousBoundary = (text: string, cursor: number) => segmenter.segment(text).containing(cursor - 1)?.index ?? 0;
export const nextBoundary = (text: string, cursor: number) => {
  const part = segmenter.segment(text).containing(cursor);
  return part ? part.index + part.segment.length : text.length;
};
export interface Draft { text: string; cursor: number }
interface Cell { text: string; start: number; width: number }
export interface PromptRow { start: number; end: number; cells: Cell[] }

export function layoutPrompt(text: string, cursor: number, columns: number) {
  const width = Math.max(1, columns);
  const rows: PromptRow[] = [{ start: 0, end: 0, cells: [] }];
  let row = rows[0]!; let used = 0;
  const newRow = (start: number) => { row = { start, end: start, cells: [] }; rows.push(row); used = 0; };
  for (const { segment, index } of segmenter.segment(text)) {
    if (segment === '\n') {
      if (index === cursor && used >= width) newRow(index);
      row.end = index; newRow(index + 1); continue;
    }
    let display = segment === '\t' ? ' '.repeat(Math.min(4, width)) : segment;
    let cells = stringWidth(display);
    if (cells > width) { display = '�'; cells = 1; }
    if (used + cells > width && used > 0) newRow(index);
    row.cells.push({ text: display, start: index, width: cells });
    row.end = index + segment.length; used += cells;
  }
  if (cursor === text.length && used >= width) newRow(text.length);
  return { rows, cursorRow: Math.max(0, rows.findLastIndex(line => line.start <= cursor)) };
}

export function verticalCursor(layout: ReturnType<typeof layoutPrompt>, cursor: number, direction: number): number {
  const row = layout.rows[layout.cursorRow]!;
  const target = layout.rows[layout.cursorRow + direction];
  if (!target) return cursor;
  const column = row.cells.filter(cell => cell.start < cursor).reduce((sum, cell) => sum + cell.width, 0);
  let used = 0;
  for (const cell of target.cells) {
    if (used + cell.width > column) return cell.start;
    used += cell.width;
  }
  return target.end;
}
