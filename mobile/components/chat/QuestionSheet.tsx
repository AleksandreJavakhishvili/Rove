import { fontSize, radius, space, useTheme } from '@/theme';
import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

interface AskOption {
  label: string;
  description?: string;
  preview?: string;
}
interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskOption[];
}

/** Defensive parse of the built-in `AskUserQuestion` tool input. */
export function parseAskUserQuestion(input: unknown): AskQuestion[] {
  const root = (input ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(root.questions) ? root.questions : [];
  const out: AskQuestion[] = [];
  for (const q of raw) {
    const o = (q ?? {}) as Record<string, unknown>;
    if (typeof o.question !== 'string') continue;
    const options: AskOption[] = [];
    for (const opt of Array.isArray(o.options) ? o.options : []) {
      const oo = (opt ?? {}) as Record<string, unknown>;
      if (typeof oo.label !== 'string') continue;
      const entry: AskOption = { label: oo.label };
      if (typeof oo.description === 'string') entry.description = oo.description;
      if (typeof oo.preview === 'string') entry.preview = oo.preview;
      options.push(entry);
    }
    out.push({
      question: o.question,
      header: typeof o.header === 'string' ? o.header : undefined,
      multiSelect: o.multiSelect === true,
      options,
    });
  }
  return out;
}

interface QuestionSheetProps {
  /** Raw `AskUserQuestion` tool input. */
  input: unknown;
  /** User answered. `answers` maps each question's text → chosen label(s) /
   *  free text (the shape the model's tool result expects). */
  onSubmit: (answers: Record<string, string>) => void;
  /** User dismissed without answering. */
  onDismiss: () => void;
}

/**
 * Interactive renderer for the built-in `AskUserQuestion` tool (Rove
 * "ask user questions" support). Replaces the raw-JSON tool card: each
 * question shows tappable options (single-choice or multi-select), plus a
 * "reply in your own words" field — the "chat about it" path, matching
 * Claude's own picker. The chosen answer is returned to the agent as the
 * tool result via the request pipeline.
 */
export function QuestionSheet({ input, onSubmit, onDismiss }: QuestionSheetProps) {
  const t = useTheme();
  const questions = useMemo(() => parseAskUserQuestion(input), [input]);
  // Per-question selected option labels + free-text ("other").
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});

  const toggle = (qi: number, label: string, multi: boolean) => {
    setSelected((prev) => {
      const cur = prev[qi] ?? [];
      if (multi) {
        return { ...prev, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      }
      return { ...prev, [qi]: cur.includes(label) ? [] : [label] };
    });
  };

  const answerFor = (qi: number): string => {
    const parts = [...(selected[qi] ?? [])];
    const free = (other[qi] ?? '').trim();
    if (free) parts.push(free);
    return parts.join(', ');
  };

  const allAnswered = questions.every((_, qi) => answerFor(qi).length > 0);

  const submit = () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, qi) => {
      const a = answerFor(qi);
      if (a) answers[q.question] = a;
    });
    onSubmit(answers);
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onDismiss}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.backdrop, { backgroundColor: t.surface.scrim }]}>
        <View style={[styles.sheet, { backgroundColor: t.surface.raised }]}>
          <View style={[styles.handle, { backgroundColor: t.text.muted }]} />
          <Text style={[styles.title, { color: t.text.primary }]}>
            {questions.length > 1 ? 'Claude has some questions' : 'Claude has a question'}
          </Text>

          <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
            {questions.map((q, qi) => (
              <View key={qi} style={styles.qBlock}>
                {q.header ? (
                  <Text style={[styles.headerChip, { color: t.accent.primary, backgroundColor: t.surface.sunken }]}>
                    {q.header}
                  </Text>
                ) : null}
                <Text style={[styles.question, { color: t.text.primary }]}>{q.question}</Text>
                {q.multiSelect ? (
                  <Text style={[styles.hint, { color: t.text.muted }]}>Select all that apply</Text>
                ) : null}

                {q.options.map((opt) => {
                  const on = (selected[qi] ?? []).includes(opt.label);
                  return (
                    <Pressable
                      key={opt.label}
                      onPress={() => toggle(qi, opt.label, !!q.multiSelect)}
                      style={[
                        styles.option,
                        {
                          borderColor: on ? t.accent.primary : t.border.subtle,
                          backgroundColor: on ? t.surface.sunken : 'transparent',
                        },
                      ]}>
                      <View
                        style={[
                          q.multiSelect ? styles.checkbox : styles.radio,
                          { borderColor: on ? t.accent.primary : t.border.strong },
                          on ? { backgroundColor: t.accent.primary } : null,
                        ]}>
                        {on ? <Text style={[styles.tick, { color: t.accent.fg }]}>✓</Text> : null}
                      </View>
                      <View style={styles.optBody}>
                        <Text style={[styles.optLabel, { color: t.text.primary }]}>{opt.label}</Text>
                        {opt.description ? (
                          <Text style={[styles.optDesc, { color: t.text.secondary }]}>{opt.description}</Text>
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}

                <TextInput
                  value={other[qi] ?? ''}
                  onChangeText={(v) => setOther((p) => ({ ...p, [qi]: v }))}
                  placeholder="Or reply in your own words…"
                  placeholderTextColor={t.text.placeholder}
                  multiline
                  style={[
                    styles.other,
                    { color: t.text.primary, backgroundColor: t.surface.base, borderColor: t.border.subtle },
                  ]}
                />
              </View>
            ))}
          </ScrollView>

          <View style={styles.row}>
            <Pressable
              onPress={onDismiss}
              style={({ pressed }) => [
                styles.btnSecondary,
                { backgroundColor: pressed ? t.surface.pressed : 'transparent' },
              ]}>
              <Text style={[styles.btnLabel, { color: t.text.secondary }]}>Dismiss</Text>
            </Pressable>
            <Pressable
              disabled={!allAnswered}
              onPress={submit}
              style={({ pressed }) => [
                styles.btnPrimary,
                {
                  backgroundColor: allAnswered
                    ? pressed
                      ? t.accent.pressed
                      : t.accent.primary
                    : t.surface.pressed,
                },
              ]}>
              <Text style={[styles.btnLabel, { color: allAnswered ? t.accent.fg : t.text.muted }]}>
                Send
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: space[5],
    paddingTop: space[2],
    paddingBottom: space[8] + 4,
    gap: space[3],
    maxHeight: '88%',
  },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 6, opacity: 0.4 },
  title: { fontSize: fontSize['2xl'], fontWeight: '700' },
  body: { flexGrow: 0 },
  qBlock: { gap: space[2], marginBottom: space[5] },
  headerChip: {
    alignSelf: 'flex-start',
    fontSize: fontSize.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: space[2],
    paddingVertical: 2,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  question: { fontSize: fontSize.lg, fontWeight: '600', lineHeight: 22 },
  hint: { fontSize: fontSize.xs },
  option: {
    flexDirection: 'row',
    gap: space[3],
    alignItems: 'flex-start',
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space[3],
  },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  checkbox: { width: 20, height: 20, borderRadius: radius.sm, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  tick: { fontSize: 12, fontWeight: '900', lineHeight: 14 },
  optBody: { flex: 1, gap: 2 },
  optLabel: { fontSize: fontSize.md, fontWeight: '600' },
  optDesc: { fontSize: fontSize.sm, lineHeight: 18 },
  other: {
    minHeight: 40,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    fontSize: fontSize.base,
    marginTop: space[1],
  },
  row: { flexDirection: 'row', gap: space[2] },
  btnPrimary: { paddingVertical: space[3] + 2, borderRadius: radius.xl, alignItems: 'center', flex: 1 },
  btnSecondary: { paddingVertical: space[3], paddingHorizontal: space[3], borderRadius: radius.xl, alignItems: 'center', flex: 1 },
  btnLabel: { fontSize: fontSize.lg, fontWeight: '600' },
});
