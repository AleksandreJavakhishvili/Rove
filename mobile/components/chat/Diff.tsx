import { fontFamily, fontSize, useTheme } from '@/theme';
import { diffStrings, type DiffLine } from '@/lib/diff';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

interface DiffProps {
  oldStr: string;
  newStr: string;
}

export function Diff({ oldStr, newStr }: DiffProps) {
  const t = useTheme();
  const result = useMemo(() => diffStrings(oldStr, newStr), [oldStr, newStr]);

  return (
    <View style={styles.container}>
      <View style={styles.summary}>
        <Text style={[styles.summaryRemoved, { color: t.status.danger }]}>−{result.removed}</Text>
        <Text style={[styles.summaryAdded, { color: t.status.success }]}>+{result.added}</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View>
          {result.lines.map((line, i) => (
            <DiffRow key={i} line={line} />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  const t = useTheme();
  let bg = 'transparent';
  let marker = ' ';
  let textColor = t.diff.contextFg;
  if (line.op === 'add') {
    bg = t.diff.addBg;
    marker = '+';
    textColor = t.diff.addFg;
  } else if (line.op === 'remove') {
    bg = t.diff.removeBg;
    marker = '−';
    textColor = t.diff.removeFg;
  }
  return (
    <View style={[styles.row, { backgroundColor: bg }]}>
      <Text style={[styles.marker, { color: textColor }]}>{marker}</Text>
      <Text style={[styles.lineText, { color: textColor }]} selectable>
        {line.line === '' ? ' ' : line.line}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 4 },
  summary: { flexDirection: 'row', gap: 10, paddingHorizontal: 8, paddingVertical: 4 },
  summaryRemoved: { fontSize: fontSize.sm, fontWeight: '600', fontFamily: fontFamily.mono },
  summaryAdded: { fontSize: fontSize.sm, fontWeight: '600', fontFamily: fontFamily.mono },
  row: { flexDirection: 'row', paddingHorizontal: 4 },
  marker: {
    width: 18,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.sm,
    lineHeight: 18,
    textAlign: 'center',
  },
  lineText: { fontFamily: fontFamily.mono, fontSize: fontSize.sm, lineHeight: 18 },
});
