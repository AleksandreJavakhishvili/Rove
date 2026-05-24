import {
  fetchGitStatus,
  fetchSearch,
  type GitStatusResponse,
  type SearchResponse,
} from '@/lib/bridge';
import { useHydratedSettings } from '@/lib/store';
import {
  GIT_FILE_STATUS,
  type AgentCapabilities,
  type AgentKind,
  type GitFileStatus,
  type GitStatusEntry,
  type SearchHit,
} from '@/lib/types';
import { fontFamily, fontSize, radius, space, useTheme, type Theme } from '@/theme';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

export interface FilesPaneProps {
  agent: AgentKind;
  sessionId: string;
  /** Whether this page is currently visible in the pager. We use it to
   *  refresh git status on focus + skip work when offscreen. */
  active: boolean;
  /** Files the *session* has touched (live-streamed). Drives the "Changed
   *  this session" section. */
  sessionChanges: Map<string, 'add' | 'change' | 'unlink'>;
  /** Capability snapshot — drives which sections are rendered. */
  capabilities: AgentCapabilities | null;
}

/**
 * Third pager page (Chat | **Files** | Preview) added in Phase 4 of the
 * mobile-file-visibility SDD.
 *
 * Three sections, each independently capability-gated:
 *   1. Search bar — placeholder for Phase 5 (`/search`).
 *   2. Git working tree — full `git status` independent of session
 *      baseline. Tap to open per-file git diff. Gated on
 *      `caps.gitStatus`.
 *   3. Session changes — files the agent has touched this session. Tap
 *      to open per-file *session* diff (vs baseline SHA). Always
 *      visible when non-empty.
 *   4. Project tree — placeholder until Phase 5 wires the recursive
 *      `/tree` browser. The mention picker already uses /tree under the
 *      hood; this section will reuse the same fetch.
 */
export function FilesPane({
  agent,
  sessionId,
  active,
  sessionChanges,
  capabilities,
}: FilesPaneProps) {
  const t = useTheme();
  const settings = useHydratedSettings();
  const [git, setGit] = useState<GitStatusResponse | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  const [gitLoading, setGitLoading] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResponse | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);

  const [gitSectionOpen, setGitSectionOpen] = useState(true);
  const [sessionSectionOpen, setSessionSectionOpen] = useState(true);
  const [treeSectionOpen, setTreeSectionOpen] = useState(false);

  const supportsGit = Boolean(capabilities?.gitStatus);
  const supportsBrowser = Boolean(capabilities?.projectBrowser);
  const supportsSearch = Boolean(capabilities?.projectSearch);

  const loadGit = useCallback(async () => {
    if (!supportsGit || !settings.baseUrl) return;
    setGitLoading(true);
    try {
      const result = await fetchGitStatus(
        { baseUrl: settings.baseUrl, token: settings.token },
        agent,
        sessionId,
      );
      setGit(result);
      setGitError(null);
    } catch (err) {
      setGitError(String((err as Error).message ?? err));
    } finally {
      setGitLoading(false);
    }
  }, [supportsGit, settings.baseUrl, settings.token, agent, sessionId]);

  // Refresh git status whenever the Files page becomes active. Cheaper
  // than a polling loop and matches the user's intent ("I just swiped to
  // the Files tab; show me what's there").
  useEffect(() => {
    if (active) {
      loadGit();
    }
  }, [active, loadGit]);

  // Generation counter so a late-arriving response from a stale request
  // can't overwrite the results of a newer query the user has already
  // typed past.
  const searchGen = useRef(0);

  const runSearch = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      if (!q || !supportsSearch || !settings.baseUrl) return;
      const gen = ++searchGen.current;
      setSearchLoading(true);
      setSearchError(null);
      try {
        const result = await fetchSearch(
          { baseUrl: settings.baseUrl, token: settings.token },
          agent,
          sessionId,
          q,
          { limit: 100 },
        );
        if (gen !== searchGen.current) return;
        setSearchResults(result);
      } catch (err) {
        if (gen !== searchGen.current) return;
        setSearchError(String((err as Error).message ?? err));
        setSearchResults(null);
      } finally {
        if (gen === searchGen.current) setSearchLoading(false);
      }
    },
    [supportsSearch, settings.baseUrl, settings.token, agent, sessionId],
  );

  const clearSearch = useCallback(() => {
    searchGen.current++;
    setSearchQuery('');
    setSearchResults(null);
    setSearchError(null);
    setSearchLoading(false);
  }, []);

  // Debounce search-as-you-type so we don't fire a ripgrep on every
  // keystroke. Short trims (< 2 chars) are ignored to avoid pathological
  // wide matches; clearing the box clears results immediately.
  useEffect(() => {
    if (!supportsSearch) return;
    const q = searchQuery.trim();
    if (q.length === 0) {
      searchGen.current++;
      setSearchResults(null);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }
    if (q.length < 2) return;
    const handle = setTimeout(() => {
      void runSearch(q);
    }, 250);
    return () => clearTimeout(handle);
  }, [searchQuery, supportsSearch, runSearch]);

  const sessionEntries = useMemo(() => Array.from(sessionChanges.entries()), [sessionChanges]);

  const stagedEntries = useMemo(
    () => (git?.entries ?? []).filter((e) => e.indexStatus !== GIT_FILE_STATUS.unmodified),
    [git],
  );
  const unstagedEntries = useMemo(
    () =>
      (git?.entries ?? []).filter(
        (e) =>
          e.indexStatus === GIT_FILE_STATUS.unmodified &&
          !e.isUntracked &&
          !e.isIgnored,
      ),
    [git],
  );
  const untrackedEntries = useMemo(
    () => (git?.entries ?? []).filter((e) => e.isUntracked),
    [git],
  );

  // Sections collapse to "hidden" during an active search so the screen
  // doesn't render two parallel content areas (results above, sections
  // below). The "Clear" button on the search bar drops back to defaults.
  const inSearchMode = Boolean(searchResults || searchError || searchLoading);
  const showGitSection = supportsGit && !inSearchMode;
  const showSessionSection = sessionEntries.length > 0 && !inSearchMode;
  const showTreeSection = supportsBrowser && !inSearchMode;

  return (
    <View style={{ flex: 1, backgroundColor: t.surface.base }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled">
        {/* Search bar — backed by /search (ripgrep with grep fallback).
         *  Gated on `projectSearch` capability. Search-as-you-type with
         *  a 250ms debounce; "Clear" returns to the sectioned view. */}
        {supportsSearch ? (
          <View style={[styles.searchRow, { borderBottomColor: t.border.subtle }]}>
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Search file contents…"
              placeholderTextColor={t.text.placeholder}
              style={[
                styles.searchInput,
                { color: t.text.primary, backgroundColor: t.surface.raised },
              ]}
            />
            {searchQuery.length > 0 ? (
              <Pressable onPress={clearSearch} hitSlop={8} style={styles.searchClear}>
                <Text style={[styles.searchClearText, { color: t.accent.primary }]}>Clear</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {/* Active-search mode: render results in place of the three
         *  default sections. "Clear" returns to the sectioned view. */}
        {searchResults || searchError || searchLoading ? (
          <View style={styles.searchResultsBlock}>
            {searchLoading ? (
              <View style={styles.inlineLoading}>
                <ActivityIndicator size="small" color={t.text.secondary} />
                <Text style={[styles.muted, { color: t.text.secondary }]}>Searching…</Text>
              </View>
            ) : searchError ? (
              <Text style={[styles.muted, { color: t.status.danger }]} numberOfLines={3}>
                {searchError}
              </Text>
            ) : searchResults && searchResults.hits.length === 0 ? (
              <Text style={[styles.muted, { color: t.text.muted }]}>
                No matches for &ldquo;{searchQuery}&rdquo;.
              </Text>
            ) : searchResults ? (
              <View>
                <Text style={[styles.muted, { color: t.text.secondary }]}>
                  {searchResults.hits.length}
                  {searchResults.truncated ? '+' : ''}
                  {' matches via '}
                  {searchResults.backend}
                </Text>
                {searchResults.hits.map((hit, i) => (
                  <SearchHitRow
                    key={`${hit.path}:${hit.line}:${i}`}
                    hit={hit}
                    agent={agent}
                    sessionId={sessionId}
                    t={t}
                  />
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {/* Default (no active search) sections. */}
        {showGitSection ? (
          <Section
            title="Git working tree"
            count={git ? git.entries.length : null}
            isOpen={gitSectionOpen}
            onToggle={() => setGitSectionOpen((o) => !o)}
            t={t}>
            {gitLoading && !git ? (
              <View style={styles.inlineLoading}>
                <ActivityIndicator size="small" color={t.text.secondary} />
                <Text style={[styles.muted, { color: t.text.secondary }]}>
                  Loading git status…
                </Text>
              </View>
            ) : gitError ? (
              <Text style={[styles.muted, { color: t.status.danger }]} numberOfLines={3}>
                {gitError}
              </Text>
            ) : git && !git.isRepo ? (
              <Text style={[styles.muted, { color: t.text.muted }]}>
                cwd is not a git repository
              </Text>
            ) : git && git.entries.length === 0 ? (
              <Text style={[styles.muted, { color: t.text.muted }]}>
                Working tree clean
              </Text>
            ) : git ? (
              <View>
                <BranchLine git={git} t={t} />
                {stagedEntries.length > 0 ? (
                  <SubSection label={`Staged (${stagedEntries.length})`} t={t}>
                    {stagedEntries.map((e) => (
                      <GitRow
                        key={`s-${e.path}`}
                        entry={e}
                        side="staged"
                        agent={agent}
                        sessionId={sessionId}
                        t={t}
                      />
                    ))}
                  </SubSection>
                ) : null}
                {unstagedEntries.length > 0 ? (
                  <SubSection label={`Modified (${unstagedEntries.length})`} t={t}>
                    {unstagedEntries.map((e) => (
                      <GitRow
                        key={`u-${e.path}`}
                        entry={e}
                        side="unstaged"
                        agent={agent}
                        sessionId={sessionId}
                        t={t}
                      />
                    ))}
                  </SubSection>
                ) : null}
                {untrackedEntries.length > 0 ? (
                  <SubSection label={`Untracked (${untrackedEntries.length})`} t={t}>
                    {untrackedEntries.map((e) => (
                      <GitRow
                        key={`?-${e.path}`}
                        entry={e}
                        side="untracked"
                        agent={agent}
                        sessionId={sessionId}
                        t={t}
                      />
                    ))}
                  </SubSection>
                ) : null}
              </View>
            ) : null}
          </Section>
        ) : null}

        {showSessionSection ? (
          <Section
            title="Changed this session"
            count={sessionEntries.length}
            isOpen={sessionSectionOpen}
            onToggle={() => setSessionSectionOpen((o) => !o)}
            t={t}>
            {sessionEntries.map(([path, op]) => {
              const meta = sessionOpStyle(op, t);
              const encoded = encodeURIComponent(path);
              return (
                <Pressable
                  key={path}
                  onPress={() => router.push(`/sessions/${agent}/${sessionId}/diff?path=${encoded}`)}
                  onLongPress={() => router.push(`/sessions/${agent}/${sessionId}/file?path=${encoded}`)}
                  delayLongPress={350}
                  style={({ pressed }) => [
                    styles.row,
                    { backgroundColor: pressed ? t.surface.pressed : 'transparent' },
                  ]}>
                  <Text style={[styles.statusBadge, { color: meta.color, borderColor: meta.color }]}>
                    {meta.symbol}
                  </Text>
                  <Text style={[styles.filePath, { color: t.text.primary }]} numberOfLines={1}>
                    {path}
                  </Text>
                </Pressable>
              );
            })}
          </Section>
        ) : null}

        {showTreeSection ? (
          <Section
            title="Project tree"
            count={null}
            isOpen={treeSectionOpen}
            onToggle={() => setTreeSectionOpen((o) => !o)}
            t={t}>
            <Text style={[styles.muted, { color: t.text.muted }]}>
              Full project browser arrives in a follow-up phase. For now,
              use @ in the chat input to reference files.
            </Text>
          </Section>
        ) : null}

        {!showGitSection && !showSessionSection && !showTreeSection ? (
          <View style={{ padding: space[4] }}>
            <Text style={[styles.muted, { color: t.text.muted }]}>
              This agent doesn't expose file visibility. Add capabilities
              to its driver to populate this tab.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Section({
  title,
  count,
  isOpen,
  onToggle,
  t,
  children,
}: {
  title: string;
  count: number | null;
  isOpen: boolean;
  onToggle: () => void;
  t: Theme;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.section, { borderBottomColor: t.border.subtle }]}>
      <Pressable onPress={onToggle} style={styles.sectionHeader}>
        <Text style={[styles.sectionTitle, { color: t.text.primary }]}>
          {title}
          {count !== null ? <Text style={{ color: t.text.muted }}>  {count}</Text> : null}
        </Text>
        <Text style={[styles.toggle, { color: t.text.secondary }]}>{isOpen ? '▾' : '▸'}</Text>
      </Pressable>
      {isOpen ? <View style={styles.sectionBody}>{children}</View> : null}
    </View>
  );
}

function SubSection({
  label,
  t,
  children,
}: {
  label: string;
  t: Theme;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.subSection}>
      <Text style={[styles.subSectionLabel, { color: t.text.secondary }]}>{label}</Text>
      {children}
    </View>
  );
}

function BranchLine({ git, t }: { git: GitStatusResponse; t: Theme }) {
  const parts: string[] = [];
  if (git.branch) parts.push(git.branch);
  if (git.upstream) parts.push(`↑${git.ahead} ↓${git.behind}`);
  if (git.incomplete) parts.push('(partial)');
  if (parts.length === 0) return null;
  return (
    <Text style={[styles.branchLine, { color: t.text.secondary }]}>{parts.join(' · ')}</Text>
  );
}

function GitRow({
  entry,
  side,
  agent,
  sessionId,
  t,
}: {
  entry: GitStatusEntry;
  side: 'staged' | 'unstaged' | 'untracked';
  agent: AgentKind;
  sessionId: string;
  t: Theme;
}) {
  // Pick the status to display: staged side shows index status; unstaged /
  // untracked show worktree status. Keeps the badge meaningful per group
  // without cramming both letters into a single cell.
  const status = side === 'staged' ? entry.indexStatus : entry.worktreeStatus;
  const meta = gitStatusStyle(status, t);
  const encoded = encodeURIComponent(entry.path);
  const onPress = () => {
    if (side === 'untracked') {
      // Untracked files have no HEAD/index to diff against — open the
      // viewer instead.
      router.push(`/sessions/${agent}/${sessionId}/file?path=${encoded}`);
      return;
    }
    router.push(
      `/sessions/${agent}/${sessionId}/diff?source=git&path=${encoded}${side === 'staged' ? '&staged=true' : ''}`,
    );
  };
  const onLongPress = () => router.push(`/sessions/${agent}/${sessionId}/file?path=${encoded}`);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? t.surface.pressed : 'transparent' },
      ]}>
      <Text style={[styles.statusBadge, { color: meta.color, borderColor: meta.color }]}>
        {meta.symbol}
      </Text>
      <Text style={[styles.filePath, { color: t.text.primary }]} numberOfLines={1}>
        {entry.path}
        {entry.renamedFrom ? (
          <Text style={{ color: t.text.muted }}>  ← {entry.renamedFrom}</Text>
        ) : null}
      </Text>
    </Pressable>
  );
}

function SearchHitRow({
  hit,
  agent,
  sessionId,
  t,
}: {
  hit: SearchHit;
  agent: AgentKind;
  sessionId: string;
  t: Theme;
}) {
  const encoded = encodeURIComponent(hit.path);
  const onPress = () =>
    router.push(
      `/sessions/${agent}/${sessionId}/file?path=${encoded}&line=${hit.line}`,
    );
  // Split the preview around the match so we can colorize the hit.
  const before = hit.preview.slice(0, hit.matchStart);
  const match = hit.preview.slice(hit.matchStart, hit.matchEnd);
  const after = hit.preview.slice(hit.matchEnd);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.searchHitRow,
        { backgroundColor: pressed ? t.surface.pressed : 'transparent' },
      ]}>
      <Text style={[styles.searchHitPath, { color: t.text.primary }]} numberOfLines={1}>
        {hit.path}
        <Text style={{ color: t.text.muted }}>{`:${hit.line}`}</Text>
      </Text>
      <Text style={[styles.searchHitPreview, { color: t.text.secondary }]} numberOfLines={2}>
        {before}
        <Text style={{ color: t.accent.primary, fontWeight: '700' }}>{match}</Text>
        {after}
      </Text>
    </Pressable>
  );
}

function gitStatusStyle(status: GitFileStatus, t: Theme): { color: string; symbol: string } {
  switch (status) {
    case GIT_FILE_STATUS.added:
    case GIT_FILE_STATUS.copied:
    case GIT_FILE_STATUS.untracked:
      return { color: t.op.add, symbol: 'A' };
    case GIT_FILE_STATUS.deleted:
      return { color: t.op.unlink, symbol: 'D' };
    case GIT_FILE_STATUS.renamed:
      return { color: t.op.change, symbol: 'R' };
    case GIT_FILE_STATUS.typeChange:
      return { color: t.op.change, symbol: 'T' };
    case GIT_FILE_STATUS.updatedButUnmerged:
      return { color: t.status.danger, symbol: 'U' };
    case GIT_FILE_STATUS.ignored:
      return { color: t.text.muted, symbol: 'I' };
    case GIT_FILE_STATUS.modified:
    case GIT_FILE_STATUS.unmodified:
    default:
      return { color: t.op.change, symbol: 'M' };
  }
}

function sessionOpStyle(
  op: 'add' | 'change' | 'unlink',
  t: Theme,
): { color: string; symbol: string } {
  if (op === 'add') return { color: t.op.add, symbol: 'A' };
  if (op === 'unlink') return { color: t.op.unlink, symbol: 'D' };
  return { color: t.op.change, symbol: 'M' };
}

const styles = StyleSheet.create({
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchInput: {
    flex: 1,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderRadius: radius.md,
    fontSize: fontSize.base,
  },
  searchClear: {
    paddingHorizontal: space[2],
    paddingVertical: space[1],
  },
  searchClearText: { fontSize: fontSize.sm, fontWeight: '600' },
  searchResultsBlock: {
    paddingTop: space[1],
    paddingBottom: space[2],
  },
  searchHitRow: {
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    gap: 2,
  },
  searchHitPath: { fontSize: fontSize.sm, fontFamily: fontFamily.mono },
  searchHitPreview: {
    fontSize: fontSize.xs,
    fontFamily: fontFamily.mono,
    lineHeight: 16,
  },
  section: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[3],
    paddingVertical: space[2] + 2,
  },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '600' },
  toggle: { fontSize: fontSize.md, fontWeight: '600' },
  sectionBody: { paddingBottom: space[2] },
  subSection: { paddingTop: 4 },
  subSectionLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: space[3],
    paddingVertical: space[1],
  },
  branchLine: {
    fontSize: fontSize.xs,
    fontFamily: fontFamily.mono,
    paddingHorizontal: space[3],
    paddingBottom: space[1],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[3],
    paddingVertical: space[1.5],
  },
  statusBadge: {
    width: 20,
    height: 20,
    borderWidth: 1.5,
    borderRadius: 10,
    textAlign: 'center',
    lineHeight: 17,
    fontWeight: '700',
    fontSize: fontSize.xs - 1,
  },
  filePath: {
    flex: 1,
    fontSize: fontSize.sm,
    fontFamily: fontFamily.mono,
  },
  inlineLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[3],
    paddingVertical: space[2],
  },
  muted: {
    fontSize: fontSize.sm,
    fontStyle: 'italic',
    paddingHorizontal: space[3],
    paddingVertical: space[2],
  },
});
