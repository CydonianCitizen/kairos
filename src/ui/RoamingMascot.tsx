import { useEffect, useRef, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from './theme.js';
import { safeText } from './text.js';

export type KaironMood = 'idle' | 'thinking' | 'pacing' | 'error';

interface RoamingMascotProps {
  mood?: KaironMood;
  statusText?: string;
  columns?: number;
}

interface WalkState {
  x: number;
  targetX: number;
  dir: 1 | -1;
  pauseTicks: number;
  frame: number;
  walking: boolean;
  blink: boolean;
}

const SPRITE_WIDTH = 11;

export function RoamingMascot({ mood = 'idle', statusText, columns }: RoamingMascotProps) {
  const { stdout } = useStdout();
  const [terminalColumns, setTerminalColumns] = useState(stdout.columns || 80);
  const stateRef = useRef<WalkState>({ x: 4, targetX: 22, dir: 1, pauseTicks: 0, frame: 0, walking: true, blink: false });
  const [state, setState] = useState(stateRef.current);
  const width = Math.max(0, columns ?? terminalColumns);
  const bubble = statusText ? safeText(statusText).replace(/[\r\n\t]/g, ' ') : '';
  const maxX = Math.max(0, Math.min(70, width - SPRITE_WIDTH - (bubble ? 16 : 0)));
  const visible = width >= SPRITE_WIDTH;

  useEffect(() => {
    if (columns !== undefined) return;
    const resize = () => setTerminalColumns(stdout.columns || 80);
    stdout.on('resize', resize);
    return () => { stdout.off('resize', resize); };
  }, [stdout, columns]);

  useEffect(() => {
    // Resting poses are static; the activity bar owns the live NIM countdown.
    if (!visible || mood === 'pacing' || mood === 'error') return;
    const timer = setInterval(() => {
      const s = { ...stateRef.current };
      s.x = Math.min(s.x, maxX);
      s.targetX = Math.min(s.targetX, maxX);
      s.frame = (s.frame + 1) % 2;
      s.walking = false;
      if (s.pauseTicks > 0) {
        s.pauseTicks--;
        if (s.pauseTicks === 2 && Math.random() < 0.4) s.dir = s.dir === 1 ? -1 : 1;
      } else if (s.x === s.targetX || Math.random() < 0.05) {
        s.pauseTicks = mood === 'thinking' ? Math.floor(Math.random() * 2) : 4 + Math.floor(Math.random() * 9);
        const minTarget = Math.min(2, maxX);
        const maxTarget = Math.max(minTarget, maxX - 2);
        let target = minTarget + Math.floor(Math.random() * (maxTarget - minTarget + 1));
        if (Math.abs(target - s.x) < 4) target = s.x + 8 <= maxTarget ? s.x + 8 : Math.max(minTarget, s.x - 8);
        s.targetX = target;
      } else {
        s.dir = s.targetX > s.x ? 1 : -1;
        s.x += s.dir;
        s.walking = true;
      }
      s.blink = !s.walking && s.frame === 1 && Math.random() < 0.2;
      stateRef.current = s;
      setState(s);
    }, mood === 'thinking' ? 140 : 280);
    return () => clearInterval(timer);
  }, [mood, maxX, visible]);

  if (!visible) return null;
  const walking = state.walking && maxX > 0 && mood !== 'pacing' && mood !== 'error';
  const crest = mood === 'pacing' ? state.dir === 1 ? '  ▄▄█▀   ' : '   ▀█▄▄  '
    : state.dir === 1 ? walking && state.frame === 1 ? '  ▄▄██▀  ' : '   ▄██▀  '
    : walking && state.frame === 1 ? '  ▀██▄▄  ' : '  ▀██▄   ';
  const eyes = mood === 'error' ? '× ×' : mood === 'pacing' ? '─ ─'
    : mood === 'thinking' ? state.frame === 0 ? '✦ ✦' : '● ●' : state.blink ? '─ ─' : '● ●';
  const eyeColor = mood === 'error' ? theme.nimError : mood === 'pacing' ? theme.brandAccent : theme.graph;
  const leftWing = !walking ? ' ▀▄' : state.frame === 0 ? '▀▄▀' : '▄▀▄';
  const rightWing = !walking ? '▄▀ ' : state.frame === 0 ? '▀▄▀' : '▄▀▄';

  return <Box width={width} height={4} flexShrink={0} alignItems="flex-end" overflow="hidden">
    <Box flexDirection="column" width={SPRITE_WIDTH} flexShrink={0} marginLeft={Math.min(state.x, maxX)}>
      <Text color={theme.brand} bold wrap="truncate">{crest}</Text>
      <Text wrap="truncate">
        <Text color={theme.brand}>{state.dir === 1 ? ' ▄██ ' : ' ▄█ '}</Text>
        <Text color={eyeColor} bold>{eyes}</Text>
        <Text color={theme.brand}>{state.dir === 1 ? ' █▄' : ' ██▄'}</Text>
      </Text>
      <Text color={theme.brandAccent} wrap="truncate">{'  ▀█████▀ '}</Text>
      <Text wrap="truncate">
        <Text color={theme.brand} bold>{leftWing}</Text>
        <Text color={theme.brandAccent}>{' ▀ ▀ '}</Text>
        <Text color={theme.brand} bold>{rightWing}</Text>
      </Text>
    </Box>
    {!!bubble && <Box marginLeft={1} marginBottom={1} flexShrink={1} minWidth={0}>
      <Text color={mood === 'error' ? theme.nimError : mood === 'pacing' ? theme.brandAccent : theme.graph} wrap="truncate">
        {mood === 'pacing' ? '⏳ ' : '💬 '}{bubble}
      </Text>
    </Box>}
  </Box>;
}
