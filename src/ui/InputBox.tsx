import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useStdin, useStdout } from 'ink';
import type { UiController } from './controller.js';
import { theme } from './theme.js';
import { safeText } from './text.js';
import { CommandMenu } from './CommandMenu.js';
import { layoutPrompt, nextBoundary, previousBoundary, verticalCursor, type Draft } from './prompt-editor.js';

interface InputBoxProps {
  controller: UiController;
  busy: boolean;
  onToggleDetails: () => void;
  maxSuggestions?: number;
  maxInputRows?: number;
  columns?: number;
  onMenuRowsChange?: (rows: number) => void;
}
const cleanInput = (text: string) => safeText(text.replace(/\r\n?/g, '\n'));
const emptyDraft: Draft = { text: '', cursor: 0 };

export function InputBox({ controller, busy, onToggleDetails, maxSuggestions = 6, maxInputRows = 6, columns = 80, onMenuRowsChange }: InputBoxProps) {
  const { stdin, setRawMode } = useStdin(); const { stdout } = useStdout();
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const editing = state.queueEdit;
  const selecting = state.selectedQueuedId !== undefined;
  const queueSelection = state.queue?.find(item => item.id === state.selectedQueuedId);
  const [draft, setDraft] = useState<Draft>(() => editing?.previousDraft ?? emptyDraft);
  const [selected, setSelected] = useState(0);
  const [search, setSearch] = useState<Draft | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyStatus, setHistoryStatus] = useState('');
  const [limitReached, setLimitReached] = useState(false);
  const request = useRef(0); const paste = useRef<string | null>(null);
  const active = search ?? editing?.draft ?? draft;
  const preview = queueSelection ? cleanInput(queueSelection.text) : undefined;
  const displayDraft = preview === undefined ? active : { text: preview, cursor: preview.length };
  const layout = layoutPrompt(displayDraft.text, displayDraft.cursor, Math.max(1, columns - 4));
  const visibleRows = Math.max(1, Math.min(search ? 1 : maxInputRows, layout.rows.length));
  const startRow = Math.max(0, layout.cursorRow - visibleRows + 1);
  const commands = search || editing || selecting || draft.cursor !== draft.text.length ? [] : controller.commandSuggestions(draft.text);
  const prefix = active.text.slice(0, active.cursor);
  const suggestions = search || selecting || editing && /^\/\S*$/.test(prefix) ? [] : controller.suggestions(prefix);
  const matches = search ? history.filter(text => text.toLowerCase().includes(search.text.toLowerCase())).reverse() : [];
  const matchCount = Math.max(1, Math.min(maxSuggestions, 5, matches.length));
  const matchIndex = matches.length ? selected % matches.length : 0;
  const matchStart = Math.max(0, Math.min(matchIndex - Math.floor(matchCount / 2), matches.length - matchCount));
  const menuRows = search ? 1 + matchCount : commands.length ? Math.min(commands.length, maxSuggestions) + 1 : 0;
  const showHint = !!search || !!editing || selecting || !!commands.length || layout.rows.length > 1 || limitReached;
  const extraRows = menuRows + visibleRows - 1 + (!showHint && !suggestions.length ? 0 : 1);
  useEffect(() => { onMenuRowsChange?.(extraRows); }, [extraRows, onMenuRowsChange]);

  const setActiveDraft = (next: Draft) => { if (search) setSearch(next); else if (editing) controller.updateQueueDraft(next); else setDraft(next); };
  const change = (next: Draft) => { setActiveDraft(next); setSelected(0); setLimitReached(false); };
  const insert = (text: string) => {
    if (selecting) controller.clearQueueSelection();
    const clean = search ? cleanInput(text).replace(/[\n\t]/g, ' ') : cleanInput(text);
    const next = active.text.slice(0, active.cursor) + clean + active.text.slice(active.cursor);
    if (next.length > 64000) { setLimitReached(true); return; }
    change({ text: next, cursor: active.cursor + clean.length });
  };
  const closeSearch = () => { request.current++; setSearch(null); setSelected(0); setHistoryStatus(''); };
  const acceptHistory = () => { const match = matches[matchIndex]; if (match !== undefined) { const text = cleanInput(match); const next = { text, cursor: text.length }; if (editing) controller.updateQueueDraft(next); else setDraft(next); closeSearch(); } };
  const reset = (text: string) => { setDraft({ text, cursor: text.length }); setSelected(0); setLimitReached(false); };
  const receive = (raw: string) => {
    if (paste.current !== null || raw.startsWith('\x1b[200~')) {
      const chunk = paste.current === null ? raw.slice(6) : raw;
      const buffered = (paste.current ?? '') + chunk;
      const end = buffered.indexOf('\x1b[201~');
      if (end >= 0) { paste.current = null; insert(buffered.slice(0, end)); }
      else paste.current = buffered.slice(0, 64007);
      return;
    }
    if (raw === '\x12') {
      if (selecting) controller.clearQueueSelection();
      if (search) { if (matches.length) setSelected(n => (n + 1) % matches.length); return; }
      setSearch(emptyDraft); setSelected(0); setHistoryStatus('Loading prompt history…');
      const id = ++request.current;
      void controller.promptHistory().then(items => {
        if (request.current === id) { setHistory(items); setHistoryStatus(''); }
      }).catch(() => { if (request.current === id) setHistoryStatus('Prompt history unavailable'); });
      return;
    }
    if (raw === '\x1b' || raw === '\x03') {
      if (search) closeSearch();
      else if (editing) controller.cancelQueueEdit();
      else if (selecting) controller.clearQueueSelection();
      else if (commands.length) reset('');
      else if (raw === '\x1b') controller.cancel();
      else controller.cancelOrExit();
      return;
    }
    if (raw === '\t') {
      if (search) { acceptHistory(); return; }
      if (selecting) { controller.beginQueueEdit(state.selectedQueuedId!, draft); return; }
      if (suggestions.length) {
        const choice = suggestions[selected % suggestions.length]!;
        const text = /^\/\S*$/.test(prefix)
          ? choice + ' '
          : /\$[^\s]*$/.test(prefix)
            ? prefix.replace(/\$[^\s]*$/, choice.startsWith('$') ? `${choice} ` : `$${choice} `)
            : prefix.replace(/@[^\s]*$/, `@${choice} `);
        setActiveDraft({ text: text + active.text.slice(active.cursor), cursor: text.length }); setSelected(0);
      } else onToggleDetails();
      return;
    }
    const up = raw === '\x1b[A' || raw === '\x1bOA';
    const down = raw === '\x1b[B' || raw === '\x1bOB';
    if (up || down) {
      if (!search && !editing && (selecting || up && !suggestions.length && layout.cursorRow === 0 && state.queue?.length)) { controller.selectQueued(up ? -1 : 1); return; }
      const count = search ? matches.length : suggestions.length;
      if (count) setSelected(n => (n + (up ? count - 1 : 1)) % count);
      else if (!search) setActiveDraft({ ...active, cursor: verticalCursor(layout, active.cursor, up ? -1 : 1) });
      return;
    }
    if (raw === '\r') {
      if (search) { acceptHistory(); return; }
      if (selecting) { controller.beginQueueEdit(state.selectedQueuedId!, draft); return; }
      if (active.text[active.cursor - 1] === '\\') {
        change({ text: active.text.slice(0, active.cursor - 1) + '\n' + active.text.slice(active.cursor), cursor: active.cursor }); return;
      }
      if (editing) { controller.saveQueueEdit(); return; }
      const command = commands[selected % commands.length];
      if (command?.argument) { reset(command.name + ' '); return; }
      if (draft.text.trim()) { reset(''); void controller.submit(command?.name ?? draft.text); }
      return;
    }
    if (selecting) controller.clearQueueSelection();
    if (['\n', '\x1b\r', '\x1b[13;2u', '\x1b[27;2;13~'].includes(raw)) { if (!search) insert('\n'); return; }
    if (raw === '\x7f' || raw === '\b' || raw === '\x1b[3~') {
      const from = raw === '\x1b[3~' ? active.cursor : previousBoundary(active.text, active.cursor);
      const to = raw === '\x1b[3~' ? nextBoundary(active.text, active.cursor) : active.cursor;
      change({ text: active.text.slice(0, from) + active.text.slice(to), cursor: from }); return;
    }
    if (['\x1b[D', '\x1bOD', '\x1b[C', '\x1bOC'].includes(raw)) {
      const cursor = raw.endsWith('D') ? previousBoundary(active.text, active.cursor) : nextBoundary(active.text, active.cursor);
      setActiveDraft({ ...active, cursor }); return;
    }
    if (['\x01', '\x1b[H', '\x1bOH', '\x1b[1~', '\x05', '\x1b[F', '\x1bOF', '\x1b[4~'].includes(raw)) {
      const end = raw === '\x05' || raw.endsWith('F') || raw === '\x1b[4~';
      const cursor = end ? active.text.indexOf('\n', active.cursor) : active.cursor === 0 ? 0 : active.text.lastIndexOf('\n', active.cursor - 1) + 1;
      setActiveDraft({ ...active, cursor: cursor < 0 ? active.text.length : cursor }); return;
    }
    if (raw === '\x15') { change({ ...active, text: active.text.slice(active.cursor), cursor: 0 }); return; }
    if (raw.startsWith('\x1b') || /^[\x00-\x1f]$/.test(raw)) return;
    insert(raw);
  };
  const handler = useRef(receive); handler.current = receive;
  useEffect(() => {
    const onData = (data: Buffer | string) => handler.current(data.toString());
    setRawMode(true); stdin.on('data', onData);
    if (stdout.isTTY) stdout.write('\x1b[?2004h');
    return () => {
      request.current++; stdin.off('data', onData); setRawMode(false);
      if (stdout.isTTY) stdout.write('\x1b[?2004l');
    };
  }, [stdin, stdout, setRawMode]);

  return <Box flexDirection="column">
    {search ? <Box flexDirection="column">
      <Text color={theme.brand} wrap="truncate">History · {search.text || 'type to search'}{matches.length ? ` · ${matchIndex + 1}/${matches.length}` : ''}</Text>
      {matches.length ? matches.slice(matchStart, matchStart + matchCount).map((text, i) => <Text key={matchStart + i} color={matchStart + i === matchIndex ? theme.brand : theme.textPrimary} wrap="truncate">{matchStart + i === matchIndex ? '› ' : '  '}{safeText(text).replace(/[\n\t]/g, ' ↵ ')}</Text>) : <Text color={theme.borderMuted} wrap="truncate">{historyStatus || 'No matching prompts'}</Text>}
    </Box> : !!commands.length && <CommandMenu commands={commands} selected={selected % commands.length} maxVisible={maxSuggestions} />}
    <Box borderStyle="single" borderLeft={false} borderRight={false} borderColor={busy ? theme.borderMuted : theme.brandAccent} paddingX={1}>
      <Box flexShrink={0}><Text color={theme.brand} bold>{search ? '⌕ ' : '❯ '}</Text></Box>
      <Box flexDirection="column" flexGrow={1} minWidth={0}>
        {layout.rows.slice(startRow, startRow + visibleRows).map((row, i) => {
          const cursor = startRow + i === layout.cursorRow;
          const before = row.cells.filter(cell => cell.start < displayDraft.cursor).map(cell => cell.text).join('');
          const at = row.cells.find(cell => cell.start === displayDraft.cursor);
          const after = row.cells.filter(cell => cell.start > displayDraft.cursor).map(cell => cell.text).join('');
          const placeholder = search ? 'Search prompts' : busy ? 'Queue a follow-up · /steer to guide · Esc to cancel' : 'Ask a question · /help · @file or @symbol';
          return <Text key={startRow + i} wrap="truncate">{!displayDraft.text ? <Text color={theme.borderMuted}><Text inverse>{placeholder[0]}</Text>{placeholder.slice(1)}</Text> : cursor ? <>{before}<Text inverse>{at?.text || ' '}</Text>{after}</> : row.cells.map(cell => cell.text).join('') || ' '}</Text>;
        })}
      </Box>
    </Box>
    {showHint ? <Text color={editing?.error ? theme.nimError : theme.borderMuted} wrap="truncate">{limitReached ? 'Prompt limit: 64,000 characters' : search ? '↑↓ / Ctrl+R older · Enter/Tab load · Esc back' : editing ? editing.error ? `Esc back · ${editing.error}` : columns < 60 ? `#${editing.id} · Enter save · Esc back` : `Editing #${editing.id} · Queue paused · Enter save · Esc restore draft` : selecting ? queueSelection ? `#${queueSelection.id} · Enter edit · ↑↓ · Esc back` : 'Esc back · Message is no longer waiting' : commands.length ? '↑↓ choose · Enter select · Esc back' : `Lines ${startRow + 1}–${startRow + visibleRows}/${layout.rows.length} · Enter send · Ctrl+J newline · Ctrl+R history`}</Text> : !!suggestions.length && <Text color={theme.graph} wrap="truncate">Tab → {suggestions.map((item, i) => i === selected % suggestions.length ? `[${item}]` : item).join('  ')}</Text>}
  </Box>;
}
