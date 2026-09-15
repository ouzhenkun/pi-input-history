/**
 * Persistent History + Reverse Search
 *
 * - Loads recent prompts from previous sessions into up/down history on startup.
 * - Configurable reverse search overlay (fuzzy subsequence matching).
 *
 * Config: ~/.pi/agent/pi-input-history.json
 *   { "searchShortcut": "ctrl+r", "newerShortcut": "ctrl+s" }
 *
 * Hotkeys while searching (defaults):
 * - searchShortcut / ↑ : older match
 * - newerShortcut / ↓  : newer match
 * - Enter              : accept match (fills editor)
 * - Esc/Ctrl+G         : cancel
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CustomEditor,
  SessionManager,
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { UserMessage } from "@earendil-works/pi-ai";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type KeyId,
  type TUI,
} from "@earendil-works/pi-tui";

const MAX_MESSAGES = 100;
const DEFAULT_SEARCH_SHORTCUT: KeyId = "ctrl+r";
const DEFAULT_NEWER_SHORTCUT: KeyId = "ctrl+s";
const DEFAULT_SCROLL_UP_SHORTCUT: KeyId = "ctrl+k";
const DEFAULT_SCROLL_DOWN_SHORTCUT: KeyId = "ctrl+j";
/** Visible preview lines in the reverse-search viewport. */
const PREVIEW_LINES = 3;

type Config = {
  searchShortcut: KeyId;
  newerShortcut: KeyId;
  scrollUpShortcut: KeyId;
  scrollDownShortcut: KeyId;
};

function normalizeKey(value: unknown, fallback: KeyId): KeyId {
  if (typeof value !== "string") return fallback;
  const s = value.trim().toLowerCase();
  return s.length > 0 ? (s as KeyId) : fallback;
}

function loadConfig(): Config {
  try {
    const path = join(getAgentDir(), "pi-input-history.json");
    if (!existsSync(path)) {
      return {
        searchShortcut: DEFAULT_SEARCH_SHORTCUT,
        newerShortcut: DEFAULT_NEWER_SHORTCUT,
        scrollUpShortcut: DEFAULT_SCROLL_UP_SHORTCUT,
        scrollDownShortcut: DEFAULT_SCROLL_DOWN_SHORTCUT,
      };
    }
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    return {
      searchShortcut: normalizeKey(raw.searchShortcut, DEFAULT_SEARCH_SHORTCUT),
      newerShortcut: normalizeKey(raw.newerShortcut, DEFAULT_NEWER_SHORTCUT),
      scrollUpShortcut: normalizeKey(raw.scrollUpShortcut, DEFAULT_SCROLL_UP_SHORTCUT),
      scrollDownShortcut: normalizeKey(raw.scrollDownShortcut, DEFAULT_SCROLL_DOWN_SHORTCUT),
    };
  } catch {
    return {
      searchShortcut: DEFAULT_SEARCH_SHORTCUT,
      newerShortcut: DEFAULT_NEWER_SHORTCUT,
      scrollUpShortcut: DEFAULT_SCROLL_UP_SHORTCUT,
      scrollDownShortcut: DEFAULT_SCROLL_DOWN_SHORTCUT,
    };
  }
}

// ─── Extension Entry ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  let historyCache: string[] = [];

  pi.on("session_start", async (_event, ctx) => {
    const items = await loadRecentPrompts(ctx.cwd, MAX_MESSAGES);
    historyCache = items;

    if (items.length === 0) return;

    const prevComponentFactory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor =
        prevComponentFactory?.(tui, theme, keybindings) ??
        new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });

      for (let i = items.length - 1; i >= 0; i--) {
        editor.addToHistory?.(items[i]!);
      }
      return editor;
    });
  });

  pi.registerShortcut(config.searchShortcut, {
    description: "Reverse search through prompt history",
    handler: async (ctx) => {
      const branchHistory = collectBranchHistory(ctx);
      const merged = mergeHistory(branchHistory, historyCache);

      if (merged.length === 0) {
        ctx.ui.notify("No prompt history yet.", "info");
        return;
      }

      const selected = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        return new ReverseSearchComponent(tui, theme, merged, done, config);
      }, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%" } });

      if (selected === null) return;
      ctx.ui.setEditorText(selected);
    },
  });
}

// ─── Reverse Search Component ──────────────────────────────────────────────────

type Done = (value: string | null) => void;

/** Subsequence fuzzy match: all chars in needle appear in haystack in order. */
function subsequence(haystack: string, needle: string): boolean {
  let hi = 0;
  for (let ni = 0; ni < needle.length; ni++) {
    const idx = haystack.indexOf(needle[ni], hi);
    if (idx === -1) return false;
    hi = idx + 1;
  }
  return true;
}

function fuzzyMatch(item: string, query: string): boolean {
  if (!query) return true;
  const lower = item.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((t) => subsequence(lower, t));
}

/** Find the indices matching `token` as a subsequence with the smallest spread. */
function bestSubsequenceSpan(text: string, token: string): number[] {
  const positions: number[][] = [];
  for (const ch of token) {
    const idxs: number[] = [];
    for (let i = 0; i < text.length; i++) if (text[i] === ch) idxs.push(i);
    positions.push(idxs);
  }
  if (positions.some((arr) => arr.length === 0)) return [];

  const lowerBound = (arr: number[], min: number): number => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid]! < min) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  let bestSpan = Infinity;
  let bestIdx: number[] = [];
  for (const c0 of positions[0]!) {
    const cur = [c0];
    let prev = c0;
    let ok = true;
    for (let t = 1; t < token.length; t++) {
      const arr = positions[t]!;
      const p = lowerBound(arr, prev + 1);
      if (p >= arr.length) {
        ok = false;
        break;
      }
      const nxt = arr[p]!;
      cur.push(nxt);
      prev = nxt;
    }
    if (!ok) continue;
    const span = cur[cur.length - 1]! - c0;
    if (span < bestSpan) {
      bestSpan = span;
      bestIdx = cur;
    }
  }
  return bestIdx;
}

/** Collect character indices (in `text`) matched by each query token (smallest-spread subsequence). */
function collectMatchPositions(text: string, query: string): Set<number> {
  const positions = new Set<number>();
  if (!query) return positions;
  const lower = text.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const best = bestSubsequenceSpan(lower, token);
    for (const idx of best) positions.add(idx);
  }
  return positions;
}

/** Underline + accent-highlight matched characters; plain text for the rest. */
function highlightSegments(text: string, positions: Set<number>, theme: any): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    if (positions.has(i)) {
      let j = i;
      while (j < text.length && positions.has(j)) j++;
      result += `\x1b[4m${theme.fg("accent", text.slice(i, j))}\x1b[24m`;
      i = j;
    } else {
      let j = i;
      while (j < text.length && !positions.has(j)) j++;
      result += theme.fg("text", text.slice(i, j));
      i = j;
    }
  }
  return result;
}

const GRAPHEME_SEGMENTER =
  typeof Intl !== "undefined" && typeof (Intl as any).Segmenter === "function"
    ? new (Intl as any).Segmenter(undefined, { granularity: "grapheme" })
    : null;

type WrappedLine = { text: string; start: number; end: number };

/** Soft-wrap `text` to `maxWidth` columns; `\n` forces a hard break; content is never truncated. */
function wrapText(text: string, maxWidth: number): WrappedLine[] {
  if (maxWidth <= 0) return [{ text: "", start: 0, end: 0 }];
  const lines: WrappedLine[] = [];
  let cur = "";
  let curW = 0;
  let curStart = 0;
  const push = (wLine: WrappedLine) => lines.push(wLine);
  if (GRAPHEME_SEGMENTER) {
    for (const { segment, index } of GRAPHEME_SEGMENTER.segment(text)) {
      if (segment === "\n") {
        push({ text: cur, start: curStart, end: index });
        cur = "";
        curW = 0;
        curStart = index + 1;
        continue;
      }
      const w = visibleWidth(segment);
      if (curW + w > maxWidth && curW > 0) {
        push({ text: cur, start: curStart, end: index });
        cur = segment;
        curW = w;
        curStart = index;
      } else {
        cur += segment;
        curW += w;
      }
    }
  } else {
    for (let idx = 0; idx < text.length; ) {
      const cp = text.codePointAt(idx)!;
      const ch = String.fromCodePoint(cp);
      if (ch === "\n") {
        push({ text: cur, start: curStart, end: idx });
        cur = "";
        curW = 0;
        curStart = idx + 1;
        idx += 1;
        continue;
      }
      const w = visibleWidth(ch);
      if (curW + w > maxWidth && curW > 0) {
        push({ text: cur, start: curStart, end: idx });
        cur = ch;
        curW = w;
        curStart = idx;
      } else {
        cur += ch;
        curW += w;
      }
      idx += ch.length;
    }
  }
  if (curW > 0 || text.length === 0) {
    push({ text: cur, start: curStart, end: text.length });
  } else if (text.endsWith("\n") && lines.length > 0) {
    push({ text: "", start: text.length, end: text.length });
  }
  return lines;
}

/** Highlight the matched positions within one wrapped line. */
function renderWrappedLine(line: WrappedLine, matchPositions: Set<number>, theme: any): string {
  const local = new Set<number>();
  for (const p of matchPositions) {
    if (p >= line.start && p < line.end) local.add(p - line.start);
  }
  return local.size === 0 ? theme.fg("text", line.text) : highlightSegments(line.text, local, theme);
}

/** Render the viewport over wrapped lines; mark the first matched line with `▸`. */
function renderWrappedLines(
  lines: WrappedLine[],
  scroll: number,
  viewportLines: number,
  markIndex: number,
  matchPositions: Set<number>,
  theme: any,
): string[] {
  const out: string[] = [];
  for (let k = 0; k < viewportLines; k++) {
    const ln = lines[scroll + k];
    const text = ln ? renderWrappedLine(ln, matchPositions, theme) : "";
    const arrow = ln && scroll + k === markIndex ? "▸ " : "";
    out.push(arrow + text);
  }
  return out;
}

/** Wrap a (CRLF-normalized) record, locate the first matched line, and collect match positions. */
function buildWrappedMatch(
  record: string,
  query: string,
  maxWidth: number,
): { lines: WrappedLine[]; anchor: number; positions: Set<number> } {
  const normalized = record.replace(/\r\n/g, "\n");
  const lines = wrapText(normalized, maxWidth);
  const positions = collectMatchPositions(normalized, query);
  let anchor = 0;
  if (positions.size > 0) {
    const first = Math.min(...positions);
    for (let i = 0; i < lines.length; i++) {
      if (first >= lines[i]!.start && first < lines[i]!.end) {
        anchor = i;
        break;
      }
    }
  }
  return { lines, anchor, positions };
}

class ReverseSearchComponent implements Component, Focusable {
  private _focused = false;
  private readonly input = new Input();

  private query = "";
  private matchIndices: number[] = [];
  private matchPointer = 0;
  private previewScroll = 0;
  private previewAutoLocate = true;

  constructor(
    private readonly tui: TUI,
    private readonly theme: any,
    private readonly history: string[],
    private readonly done: Done,
    private readonly config: Config,
  ) {
    this.input.onEscape = () => this.done(null);
    this.input.onSubmit = () => {
      const match = this.getCurrentMatch();
      this.done(match ?? null);
    };
    this.recomputeMatches(true);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  private recomputeMatches(resetPointer: boolean): void {
    const matches: number[] = [];
    for (let i = 0; i < this.history.length; i++) {
      if (fuzzyMatch(this.history[i]!, this.query)) {
        matches.push(i);
      }
    }
    this.matchIndices = matches;
    if (resetPointer) this.matchPointer = 0;
    if (this.matchPointer >= this.matchIndices.length) {
      this.matchPointer = Math.max(0, this.matchIndices.length - 1);
    }
    this.previewAutoLocate = true;
  }

  private getCurrentMatch(): string | undefined {
    if (this.matchIndices.length === 0) return undefined;
    const index = this.matchIndices[this.matchPointer];
    return this.history[index!];
  }

  private cycleOlder(): void {
    if (this.matchIndices.length === 0) return;
    this.matchPointer = (this.matchPointer + 1) % this.matchIndices.length;
    this.previewAutoLocate = true;
  }

  private cycleNewer(): void {
    if (this.matchIndices.length === 0) return;
    this.matchPointer = (this.matchPointer - 1 + this.matchIndices.length) % this.matchIndices.length;
    this.previewAutoLocate = true;
  }

  handleInput(data: string): void {
    if (matchesKey(data, this.config.searchShortcut) || matchesKey(data, Key.up)) {
      this.cycleOlder();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, this.config.newerShortcut) || matchesKey(data, Key.down)) {
      this.cycleNewer();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.ctrl("g"))) {
      this.done(null);
      return;
    }

    if (matchesKey(data, this.config.scrollUpShortcut)) {
      this.previewAutoLocate = false;
      this.previewScroll = Math.max(0, this.previewScroll - 1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, this.config.scrollDownShortcut)) {
      this.previewAutoLocate = false;
      this.previewScroll += 1;
      this.tui.requestRender();
      return;
    }

    const before = this.input.getValue();
    this.input.handleInput(data);
    const after = this.input.getValue();

    if (after !== before) {
      this.query = after;
      this.recomputeMatches(true);
    }

    this.tui.requestRender();
  }

  render(width: number): string[] {
    const t = this.theme;
    const currentMatch = this.getCurrentMatch();

    const prefix = "(reverse-search) ";
    const maxCounterWidth = 10;
    const availableWidth = Math.max(10, width - prefix.length - maxCounterWidth);

    const counterText = this.matchIndices.length > 0
      ? ` [${this.matchPointer + 1}/${this.matchIndices.length}]`
      : " [0/0]";

    const counter = t.fg("dim", counterText);

    const lines: string[] = [];
    if (currentMatch) {
      lines.push(t.fg("accent", prefix) + counter);
      const sep = t.fg("dim", "─".repeat(Math.max(1, width)));
      lines.push(sep);
      const { lines: wl, anchor, positions } = buildWrappedMatch(currentMatch, this.query, availableWidth);
      const terminalRows = this.tui.terminal.rows;
      const maxVp = Math.max(PREVIEW_LINES, terminalRows - 6);
      const viewportLines = Math.max(PREVIEW_LINES, Math.min(wl.length, maxVp));
      const maxScroll = Math.max(0, wl.length - viewportLines);
      const scroll = this.previewAutoLocate
        ? Math.min(maxScroll, Math.max(0, anchor - Math.floor(viewportLines / 2)))
        : Math.min(maxScroll, Math.max(0, this.previewScroll));
      this.previewScroll = scroll;
      lines.push(...renderWrappedLines(wl, scroll, viewportLines, anchor, positions, t));
      lines.push(sep);
    } else {
      lines.push(t.fg("accent", prefix) + t.fg("warning", "no match") + counter);
    }

    const inputLine = truncateToWidth(this.input.render(width)[0] ?? "", width);
    const help = truncateToWidth(
      t.fg(
        "dim",
        `${this.config.searchShortcut}/↑ older • ${this.config.newerShortcut}/↓ newer • ${this.config.scrollUpShortcut}/${this.config.scrollDownShortcut} scroll • enter accept • esc cancel`,
      ),
      width,
    );

    lines.push(inputLine, help);
    return lines.map((l) => truncateToWidth(l, width));
  }

  invalidate(): void {
    this.input.invalidate();
  }
}

// ─── History Collection ────────────────────────────────────────────────────────

/** Collect user messages from the current session branch (for up-to-date search). */
function collectBranchHistory(ctx: any): string[] {
  const history: string[] = [];
  try {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const message = entry.message as Record<string, any>;
      if (message.role !== "user") continue;
      const text = extractText(message.content)?.trim();
      if (text && text.length > 0) history.push(text);
    }
  } catch {}
  return history.reverse(); // newest first
}

/** Merge branch history (current session) with cached cross-session history, deduplicated. */
function mergeHistory(branchHistory: string[], cached: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const item of branchHistory) {
    if (!seen.has(item)) {
      seen.add(item);
      merged.push(item);
    }
  }
  for (const item of cached) {
    if (!seen.has(item)) {
      seen.add(item);
      merged.push(item);
    }
  }
  return merged;
}

async function loadRecentPrompts(
  cwd: string,
  maxMessages: number,
): Promise<string[]> {
  try {
    const sessions = await SessionManager.list(cwd);
    const sorted = sessions.sort(
      (a, b) => b.modified.getTime() - a.modified.getTime(),
    );
    const allMessages: string[] = [];
    const seen = new Set<string>();

    for (const session of sorted) {
      if (allMessages.length >= maxMessages) break;
      const userMessages = extractUserMessages(session.path);
      for (const msg of userMessages) {
        if (allMessages.length >= maxMessages) break;
        const trimmed = msg.trim();
        if (trimmed && !seen.has(trimmed)) {
          seen.add(trimmed);
          allMessages.push(trimmed);
        }
      }
    }
    return allMessages;
  } catch {
    return [];
  }
}

function extractUserMessages(sessionPath: string): string[] {
  try {
    const entries = SessionManager.open(sessionPath).getEntries();
    const messages: string[] = [];
    for (const entry of entries) {
      if (entry.type !== "message" || entry.message.role !== "user") continue;
      const text = extractText(entry.message.content);
      if (text) messages.push(text);
    }
    return messages.reverse();
  } catch {
    return [];
  }
}

function extractText(content: UserMessage["content"]): string | null {
  if (typeof content === "string") return content || null;
  return (
    content.find(
      (c): c is { type: "text"; text: string } =>
        c.type === "text" && typeof c.text === "string" && c.text.length > 0,
    )?.text ?? null
  );
}
