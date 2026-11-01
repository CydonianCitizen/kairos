import { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp, useStdin, useStdout } from 'ink';
import type { UiController } from './controller.js';
import { DiffBlock } from './DiffBlock.js';
import { ToolCallBadge } from './ToolCallBadge.js';
import { StatusBar, ActivityBar } from './StatusBar.js';
import { InputBox } from './InputBox.js';
import { Banner } from './Banner.js';
import { theme } from './theme.js';
import { ModelPicker } from './ModelPicker.js';
import { EffortPicker } from './EffortPicker.js';
import { SessionPicker } from './SessionPicker.js';
import { PinnedLayout } from './PinnedLayout.js';
import { SideQuestionPanel } from './SideQuestionPanel.js';
import { ApprovalPanel } from './ApprovalPanel.js';
import {RewindPicker} from './RewindPicker.js';
import { safeText } from './text.js';
import { formatMarkdown } from './markdown.js';

export function App({ controller, version }: { controller: UiController; version: string }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { exit } = useApp(); const { stdout } = useStdout();
  const { setRawMode } = useStdin();
  // Keep one Ink raw-mode reference while swapping input components. On Windows,
  // disabling raw mode inside a key callback can fail with a pending console read.
  useEffect(() => { setRawMode(true); return () => setRawMode(false); }, [setRawMode]);
  const [expanded, setExpanded] = useState(false);
  const [commandRows, setCommandRows] = useState(0);
  const [ready, setReady] = useState(false);
  const [columns, setColumns] = useState(stdout.columns || 80);
  const [rows, setRows] = useState(stdout.rows || 24);
  useEffect(() => { const resize = () => { setColumns(stdout.columns || 80); setRows(stdout.rows || 24); }; stdout.on('resize', resize); return () => { stdout.off('resize', resize); }; }, [stdout]);
  useEffect(() => {
    let mounted = true;
    let exiting = false;
    const stop = () => {
      if (exiting) return;
      exiting = true;
      // Let Ink finish its keyboard callback before restoring the Windows TTY mode.
      setImmediate(() => { if (mounted) exit(); });
    };
    controller.on('exit', stop);
    void controller.start().then(() => { if (mounted) setReady(true); });
    return () => { mounted = false; controller.off('exit', stop); controller.dispose(); };
  }, [controller, exit]);
  const queueFocus = !!state.queueEdit || state.selectedQueuedId !== undefined;
  const headerRows = rows >= 16 && (!queueFocus || rows >= 20) ? 6 : 1;
  const banner = headerRows === 1 ? <Text color={theme.brand} wrap="truncate">K A I R O S (κ) · v{version}</Text> : <Banner version={version} model={state.model} graphStats={state.graph} columns={columns} />;
  const bannerEntry = <Box key="kairos-banner" flexDirection="column" marginBottom={1}>{banner}</Box>;
  const historyEntries = (ready ? state.history : []).map(entry => <Box key={entry.id} flexDirection="column" marginBottom={1}>
      {entry.kind === 'diff' ? <DiffBlock diff={entry.text} /> : entry.kind === 'tool' && entry.tool ? <ToolCallBadge tool={entry.tool} /> :
        <Text color={entry.kind === 'error' ? theme.nimError : entry.kind === 'user' ? theme.brand : entry.kind === 'info' ? theme.borderMuted : theme.textPrimary}>{entry.kind === 'user' ? '❯ ' : entry.kind === 'assistant' ? '● ' : ''}{entry.kind === 'assistant' ? formatMarkdown(entry.text) : entry.text}</Text>}
    </Box>);
  const entries = ready ? (state.history.length > 0 ? [bannerEntry, ...historyEntries] : []) : [];
  const header = ready && state.history.length === 0 ? banner : undefined;
  const contentRows = Math.max(1, rows - (header ? headerRows : 0) - 1);
  const showQueue = !!state.queued && (!queueFocus || contentRows >= 6);
  const queueVisible = showQueue ? Math.min(state.queue?.length ?? 0, rows >= 24 ? 2 : 0) : 0;
  const queueRows = showQueue ? 1 + queueVisible : 0;
  const queueStart = Math.max(0, (state.queue?.findIndex(item => item.id === state.selectedQueuedId) ?? -1) - queueVisible + 1);
  const showTool = !!state.lastTool && (!queueFocus || contentRows - queueRows >= 6);
  const toolRows = showTool ? expanded && !queueFocus ? 6 : 1 : 0;
  const thinkingRows = state.showThinking && state.thinkingStream ? 2 : 0;
  const streamRows = state.streaming ? queueFocus ? Math.min(3, Math.max(0, contentRows - queueRows - toolRows - thinkingRows - 5)) : 3 : 0;
  const baseDockRows = 5 + commandRows + queueRows + streamRows + thinkingRows + toolRows;
  const showMascot = columns >= 11 && contentRows - 1 >= baseDockRows + 4;
  const sideRows = Math.max(3, Math.min(contentRows - 2, 14));
  const approvalRows = Math.max(3, Math.min(contentRows - 2, 16));
  const minDockRows = state.approval ? approvalRows + 1 : state.rewindPoints ? Math.min(contentRows,12)+1 : state.sidePanelOpen ? sideRows + 1 : state.modelPickerOpen || state.effortPickerOpen || state.resumeSessions ? 13 : baseDockRows + (showMascot ? 4 : 0);
  return <PinnedLayout entries={entries} columns={columns} rows={rows} minDockRows={minDockRows} header={header} headerRows={header ? headerRows : 0}>
    {state.approval ? <ApprovalPanel key={state.approval.id} request={state.approval} columns={columns} maxRows={approvalRows} onDecision={allowed => controller.respondApproval(allowed)} onCancel={() => controller.cancel()} /> : state.rewindPoints ? <RewindPicker points={state.rewindPoints} maxRows={Math.max(4,Math.min(contentRows-1,12))} onSelect={(id,scope)=>{void controller.submit(`/rewind ${id} ${scope}`);}} onCancel={()=>controller.cancel()} /> : state.sidePanelOpen && state.sideQuestion ? <SideQuestionPanel key={state.sideQuestion.question} question={state.sideQuestion} pending={!!state.sideBusy} mainBusy={state.busy} columns={columns} maxRows={sideRows} onHide={() => controller.hideSideQuestion()} onCancel={() => controller.cancelSideQuestion()} onClear={() => controller.clearSideQuestions()} /> : state.modelPickerOpen ? <ModelPicker model={state.model} models={controller.availableModels} maxRows={Math.min(contentRows - 2, 12)} onSelect={model => { void controller.submit(`/model ${model}`); }} onCancel={() => controller.cancel()} /> : state.effortPickerOpen ? <EffortPicker model={state.model} effort={state.effort ?? 'auto'} maxRows={Math.min(contentRows - 2, 12)} onSelect={effort => { void controller.submit(`/effort ${effort}`); }} onCancel={() => controller.cancel()} /> : state.resumeSessions ? <SessionPicker sessions={state.resumeSessions} currentId={state.sessionId} pending={state.busy} error={state.resumeError} maxRows={Math.max(4, Math.min(contentRows - 2, 12))} onSelect={id => { void controller.submit(`/resume ${id}`); }} onCancel={() => controller.cancel()} /> : <>
    {!!thinkingRows && <Box height={thinkingRows} overflow="hidden"><Text color={theme.borderMuted} italic wrap="truncate-end">💭 Thinking: {safeText(state.thinkingStream ?? '').replace(/[\r\n\t]+/g, ' ')}</Text></Box>}
    {!!streamRows && <Box height={streamRows} overflow="hidden"><Text color={theme.textPrimary}>{state.streaming.slice(-Math.max(30, columns * 2)).split('\n').slice(-streamRows).join('\n')}</Text></Box>}
    {showTool && state.lastTool && <ToolCallBadge tool={state.lastTool} expanded={expanded && !queueFocus} />}
    <ActivityBar state={state} showMascot={showMascot} columns={columns} />
    {showQueue && <Box flexDirection="column">
      <Text color={theme.brandAccent} wrap="truncate">Queued {state.queued}/20{state.queuePaused ? ' · paused' : ''} · ↑ choose · Enter edit · /queue</Text>
      {state.queue?.slice(queueStart, queueStart + queueVisible).map(item => <Text key={item.id} color={item.id === state.selectedQueuedId ? theme.brand : theme.borderMuted} wrap="truncate">{item.id === state.selectedQueuedId ? '› ' : '  '}#{item.id} {safeText(item.text).replace(/[\n\t]/g, ' ↵ ')}</Text>)}
    </Box>}
    <InputBox controller={controller} busy={state.busy} columns={columns} maxInputRows={Math.max(1, Math.min(6, contentRows - 6 - queueRows - streamRows - toolRows))} onToggleDetails={() => setExpanded(value => !value)} onMenuRowsChange={setCommandRows} maxSuggestions={Math.max(1, Math.min(6, contentRows - 8 - queueRows - streamRows - toolRows))} />
    </>}
    <StatusBar state={state} columns={columns} />
  </PinnedLayout>;
}
