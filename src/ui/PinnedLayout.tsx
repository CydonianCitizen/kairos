import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Box, Static, measureElement, type DOMElement } from 'ink';

function MeasureHistory({ entries, columns, onMeasure }: { entries: ReactElement[]; columns: number; onMeasure: (height: number) => void }) {
  const ref = useRef<DOMElement>(null);
  useEffect(() => { if (ref.current) onMeasure(measureElement(ref.current).height); }, [onMeasure]);
  return <Box height={0} flexDirection="column" flexShrink={0} overflow="hidden">
    <Box ref={ref} position="absolute" width={columns} flexDirection="column" flexShrink={0}>{entries}</Box>
  </Box>;
}

/** Measure new scrollback before flushing it so padding cannot push the prompt off the bottom. */
export function PinnedLayout({ entries, rows, columns, minDockRows, children, header, headerRows = 0 }: {
  entries: ReactElement[]; rows: number; columns: number; minDockRows: number; children: ReactNode; header?: ReactNode; headerRows?: number;
}) {
  const [layout, setLayout] = useState({ count: 0, visibleHistoryRows: 0 });
  // Reserve the last terminal row: Ink clears the screen when its live area fills every row.
  const available = Math.max(1, rows - 1);
  const historyCapacity = Math.max(0, available - Math.max(1, minDockRows));
  const visibleHistoryRows = Math.min(layout.visibleHistoryRows, historyCapacity);
  useLayoutEffect(() => {
    setLayout(previous => previous.visibleHistoryRows === visibleHistoryRows ? previous : { ...previous, visibleHistoryRows });
  }, [visibleHistoryRows]);
  const pending = entries.slice(layout.count);
  return <Box flexDirection="column" width={columns}>
    {!!pending.length && <MeasureHistory key={`${layout.count}-${entries.length}-${columns}`} entries={pending} columns={columns} onMeasure={height => {
      setLayout(previous => previous.count !== layout.count ? previous : {
        count: entries.length, visibleHistoryRows: Math.min(visibleHistoryRows + height, historyCapacity),
      });
    }} />}
    <Static items={entries.slice(0, layout.count)}>{entry => entry}</Static>
    {header ? <Box flexDirection="column" height={available} overflow="hidden">
      <Box height={headerRows} flexShrink={0} overflow="hidden">{header}</Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} justifyContent="flex-end" overflow="hidden">
        <Box flexDirection="column" flexShrink={0}>{entries.slice(-30)}</Box>
      </Box>
      <Box flexDirection="column" flexShrink={0}>{children}</Box>
    </Box> : <Box flexDirection="column" height={available - visibleHistoryRows} justifyContent="flex-end" overflow="hidden">
      <Box flexDirection="column" flexShrink={0}>{children}</Box>
    </Box>}
  </Box>;
}
