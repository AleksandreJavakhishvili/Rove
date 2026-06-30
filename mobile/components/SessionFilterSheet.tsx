import type { TaggedSession } from '@/lib/aggregator';
import type { AgentKind } from '@/lib/types';
import { fontSize, radius, space, useTheme } from '@/theme';
import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { FilterSpec } from '@/hooks/useSessionFilters';

export interface SessionFilterSheetProps {
  visible: boolean;
  onClose(): void;
  filters: FilterSpec[];
  onAddFilter(spec: FilterSpec): void;
  onRemoveFilter(index: number): void;
  onClearAll(): void;
  sessions: TaggedSession[];
}

const AGE_OPTIONS: { label: string; value: number | null }[] = [
  { label: 'Any', value: null },
  { label: '7d', value: 7 },
  { label: '14d', value: 14 },
  { label: '30d', value: 30 },
  { label: '90d', value: 90 },
];

function findFilterIndex(filters: FilterSpec[], spec: FilterSpec): number {
  return filters.findIndex((f) => f.kind === spec.kind && f.value === spec.value);
}

function useToggle(
  filters: FilterSpec[],
  onAdd: (spec: FilterSpec) => void,
  onRemove: (index: number) => void,
) {
  return (spec: FilterSpec) => {
    const idx = findFilterIndex(filters, spec);
    if (idx >= 0) onRemove(idx);
    else onAdd(spec);
  };
}

export function SessionFilterSheet({
  visible,
  onClose,
  filters,
  onAddFilter,
  onRemoveFilter,
  onClearAll,
  sessions,
}: SessionFilterSheetProps) {
  const t = useTheme();
  const toggle = useToggle(filters, onAddFilter, onRemoveFilter);

  // Distinct repo / machine / agent values from the current sessions list.
  const { repos, machines, agents } = useMemo(() => {
    const repoSet = new Set<string>();
    const machineSet = new Set<string>();
    const agentSet = new Set<AgentKind>();
    for (const s of sessions) {
      repoSet.add(s.projectName);
      machineSet.add(s.bridgeId);
      agentSet.add(s.agent);
    }
    return {
      repos: [...repoSet].sort(),
      machines: [...machineSet].sort(),
      agents: [...agentSet].sort(),
    };
  }, [sessions]);

  // Name-filter draft text — committed on each keystroke.
  const [nameDraft, setNameDraft] = useState(() => {
    const existing = filters.find((f) => f.kind === 'name');
    return existing ? (existing as Extract<FilterSpec, { kind: 'name' }>).value : '';
  });

  // Active age filter value (null = Any).
  const activeAge = useMemo<number | null>(() => {
    const f = filters.find((f) => f.kind === 'age');
    return f ? (f as Extract<FilterSpec, { kind: 'age' }>).value : null;
  }, [filters]);

  function handleNameChange(text: string) {
    setNameDraft(text);
    // Remove any existing name filter, then add new one if non-empty.
    const existingIdx = filters.findIndex((f) => f.kind === 'name');
    if (existingIdx >= 0) onRemoveFilter(existingIdx);
    if (text.trim().length > 0) onAddFilter({ kind: 'name', value: text });
  }

  function handleAgeSelect(value: number | null) {
    // Remove any existing age filter first.
    const existingIdx = filters.findIndex((f) => f.kind === 'age');
    if (existingIdx >= 0) onRemoveFilter(existingIdx);
    if (value !== null) onAddFilter({ kind: 'age', value });
  }

  function handleClearAll() {
    setNameDraft('');
    onClearAll();
  }

  function isActive(spec: FilterSpec): boolean {
    return findFilterIndex(filters, spec) >= 0;
  }

  const s = makeStyles(t);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[s.sheet, { backgroundColor: t.surface.base }]}>
          {/* Handle */}
          <View style={s.handleRow}>
            <View style={[s.handle, { backgroundColor: t.border.default }]} />
          </View>

          {/* Title row */}
          <View style={[s.titleRow, { borderBottomColor: t.border.subtle }]}>
            <Text style={[s.title, { color: t.text.primary }]}>Filter Sessions</Text>
          </View>

          <ScrollView
            style={s.scroll}
            contentContainerStyle={s.scrollContent}
            showsVerticalScrollIndicator={false}>

            {/* ── Presets ─────────────────────────────── */}
            <Text style={[s.sectionHeader, { color: t.text.muted }]}>PRESETS</Text>
            <ToggleRow
              label="Hide observer sessions"
              active={isActive({ kind: 'preset', value: 'observers' })}
              onToggle={() => toggle({ kind: 'preset', value: 'observers' })}
              t={t}
            />
            <ToggleRow
              label="Hide subagents"
              active={isActive({ kind: 'preset', value: 'subagents' })}
              onToggle={() => toggle({ kind: 'preset', value: 'subagents' })}
              t={t}
            />

            {/* ── Status ──────────────────────────────── */}
            <Text style={[s.sectionHeader, { color: t.text.muted }]}>STATUS</Text>
            <ToggleRow
              label="Hide idle"
              active={isActive({ kind: 'status', value: 'idle' })}
              onToggle={() => toggle({ kind: 'status', value: 'idle' })}
              t={t}
            />
            <ToggleRow
              label="Hide live (bridge)"
              active={isActive({ kind: 'status', value: 'live-bridge' })}
              onToggle={() => toggle({ kind: 'status', value: 'live-bridge' })}
              t={t}
            />
            <ToggleRow
              label="Hide live (desktop)"
              active={isActive({ kind: 'status', value: 'live-desktop' })}
              onToggle={() => toggle({ kind: 'status', value: 'live-desktop' })}
              t={t}
            />

            {/* ── Age ─────────────────────────────────── */}
            <Text style={[s.sectionHeader, { color: t.text.muted }]}>AGE</Text>
            <View style={s.segmentedRow}>
              {AGE_OPTIONS.map((opt) => {
                const active = opt.value === activeAge;
                return (
                  <Pressable
                    key={String(opt.value)}
                    onPress={() => handleAgeSelect(opt.value)}
                    style={[
                      s.segment,
                      {
                        backgroundColor: active ? t.accent.primary : t.surface.raised,
                        borderColor: active ? t.accent.primary : t.border.subtle,
                      },
                    ]}>
                    <Text
                      style={[
                        s.segmentLabel,
                        { color: active ? t.accent.fg : t.text.secondary },
                      ]}>
                      {opt.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* ── Name contains ───────────────────────── */}
            <Text style={[s.sectionHeader, { color: t.text.muted }]}>NAME CONTAINS</Text>
            <View style={[s.inputRow, { borderColor: t.border.default, backgroundColor: t.surface.sunken }]}>
              <TextInput
                value={nameDraft}
                onChangeText={handleNameChange}
                placeholder="e.g. claude, rove…"
                placeholderTextColor={t.text.placeholder}
                style={[s.input, { color: t.text.primary }]}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
              />
              {nameDraft.length > 0 && (
                <Pressable onPress={() => handleNameChange('')} hitSlop={8}>
                  <Ionicons name="close-circle" size={16} color={t.text.muted} />
                </Pressable>
              )}
            </View>

            {/* ── Repo / Project ──────────────────────── */}
            {repos.length > 0 && (
              <>
                <Text style={[s.sectionHeader, { color: t.text.muted }]}>REPO / PROJECT</Text>
                {repos.map((repo) => (
                  <ToggleRow
                    key={repo}
                    label={repo}
                    active={isActive({ kind: 'repo', value: repo })}
                    onToggle={() => toggle({ kind: 'repo', value: repo })}
                    t={t}
                  />
                ))}
              </>
            )}

            {/* ── Machine ─────────────────────────────── */}
            {machines.length > 1 && (
              <>
                <Text style={[s.sectionHeader, { color: t.text.muted }]}>MACHINE</Text>
                {machines.map((machineId) => (
                  <ToggleRow
                    key={machineId}
                    label={machineId}
                    active={isActive({ kind: 'machine', value: machineId })}
                    onToggle={() => toggle({ kind: 'machine', value: machineId })}
                    t={t}
                  />
                ))}
              </>
            )}

            {/* ── Agent type ──────────────────────────── */}
            {agents.length > 0 && (
              <>
                <Text style={[s.sectionHeader, { color: t.text.muted }]}>AGENT TYPE</Text>
                {agents.map((agent) => (
                  <ToggleRow
                    key={agent}
                    label={agent}
                    active={isActive({ kind: 'agent', value: agent })}
                    onToggle={() => toggle({ kind: 'agent', value: agent })}
                    t={t}
                  />
                ))}
              </>
            )}

            {/* Spacer for footer */}
            <View style={{ height: space[4] }} />
          </ScrollView>

          {/* Footer */}
          <View style={[s.footer, { borderTopColor: t.border.subtle }]}>
            <Pressable onPress={handleClearAll} hitSlop={8}>
              <Text style={[s.clearLink, { color: filters.length > 0 ? t.accent.primary : t.text.muted }]}>
                Clear all
              </Text>
            </Pressable>
            <Pressable
              onPress={onClose}
              style={[s.doneButton, { backgroundColor: t.accent.primary }]}>
              <Text style={[s.doneLabel, { color: t.accent.fg }]}>Done</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── ToggleRow ────────────────────────────────────────────────────────────────

interface ToggleRowProps {
  label: string;
  active: boolean;
  onToggle(): void;
  t: ReturnType<typeof useTheme>;
}

function ToggleRow({ label, active, onToggle, t }: ToggleRowProps) {
  return (
    <Pressable
      onPress={onToggle}
      style={({ pressed }) => [
        toggleStyles.row,
        { backgroundColor: pressed ? t.surface.sunken : 'transparent' },
      ]}>
      <Text
        numberOfLines={1}
        style={[
          toggleStyles.label,
          { color: active ? t.text.primary : t.text.secondary, fontWeight: active ? '600' : '400' },
        ]}>
        {label}
      </Text>
      <View
        style={[
          toggleStyles.check,
          {
            backgroundColor: active ? t.accent.primary : 'transparent',
            borderColor: active ? t.accent.primary : t.border.default,
          },
        ]}>
        {active && <Ionicons name="checkmark" size={12} color={t.accent.fg} />}
      </View>
    </Pressable>
  );
}

const toggleStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[4],
    paddingVertical: space[3],
  },
  label: { flex: 1, fontSize: fontSize.md, marginRight: space[3] },
  check: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

// ─── Styles ───────────────────────────────────────────────────────────────────

type T = ReturnType<typeof useTheme>;

function makeStyles(t: T) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: t.surface.scrim,
    },
    sheet: {
      borderTopLeftRadius: radius['2xl'],
      borderTopRightRadius: radius['2xl'],
      maxHeight: '85%',
    },
    handleRow: {
      alignItems: 'center',
      paddingTop: space[2],
      paddingBottom: space[1],
    },
    handle: {
      width: 36,
      height: 4,
      borderRadius: radius.pill,
    },
    titleRow: {
      paddingHorizontal: space[4],
      paddingBottom: space[3],
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    title: { fontSize: fontSize['2xl'], fontWeight: '700' },
    scroll: { flexGrow: 0 },
    scrollContent: { paddingBottom: space[2] },
    sectionHeader: {
      fontSize: fontSize.xs,
      fontWeight: '600',
      letterSpacing: 0.5,
      paddingHorizontal: space[4],
      paddingTop: space[4],
      paddingBottom: space[1],
    },
    segmentedRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: space[2],
      paddingHorizontal: space[4],
      paddingVertical: space[2],
    },
    segment: {
      paddingHorizontal: space[3],
      paddingVertical: space[1],
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
    },
    segmentLabel: { fontSize: fontSize.sm, fontWeight: '600' },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: space[4],
      marginVertical: space[1],
      paddingHorizontal: space[3],
      paddingVertical: space[2],
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      gap: space[2],
    },
    input: { flex: 1, fontSize: fontSize.md, padding: 0 },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: space[4],
      paddingVertical: space[3],
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    clearLink: { fontSize: fontSize.md, fontWeight: '500' },
    doneButton: {
      paddingHorizontal: space[5],
      paddingVertical: space[2],
      borderRadius: radius.pill,
    },
    doneLabel: { fontSize: fontSize.md, fontWeight: '600' },
  });
}
