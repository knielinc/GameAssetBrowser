/**
 * Group loose texture files into coherent PBR materials.
 *
 * THE CENTRAL INSIGHT: resolve the group jointly, never the file individually.
 *
 * `Rock_A.png` has no correct per-file answer — Albedo, Alpha, or AO? But
 * `Rock_A.png` next to `Rock_D.png` is decidable: `_D` is unambiguously
 * Diffuse, so `_A` is not Albedo. That is not a heuristic, it is a constraint.
 * So stage A emits candidate SETS, and stage C solves them against sibling
 * evidence. A file-level classifier that returns a Channel is structurally
 * incapable of being correct.
 *
 * Derived in the frontend in one memoized pass, exactly like buildFolderTree —
 * no IPC, no backend state.
 */

import type { LibFile } from "../stores/libraryStore";
import type { ChannelGroup, ThumbInfo } from "../types";
import {
  AMBIGUOUS,
  DISPLAY_PREFIXES,
  NOISE_TOKENS,
  SUFFIX_RULES,
  type Channel,
  type NormalConvention,
} from "./table";

export interface Candidate {
  channel: Channel;
  confidence: number;
  convention?: NormalConvention;
}

export interface Parsed {
  file: LibFile;
  /** Lowercase stem tokens after suffix/noise removal — the material key. */
  keyTokens: string[];
  /** Original-cased stem for display. */
  display: string;
  candidates: Candidate[];
  convention?: NormalConvention;
  resolutionToken?: number;
}

export interface Member extends Parsed {
  channel: Channel;
  /** Final confidence after joint resolution. */
  resolved: number;
  /** Set when content, not the name, decided it. */
  byContent?: boolean;
}

export interface Material {
  key: string;
  dir: string;
  display: string;
  members: Member[];
  channels: Map<Channel, Member>;
  /** Same channel claimed twice (resolution ladders, LOD tiers). */
  variants: Member[];
  /** min over assigned members. */
  confidence: number;
  convention?: NormalConvention;
}

/** A grid item: either a grouped material or a texture that stands alone. */
export type TextureItem =
  | { kind: "material"; material: Material; key: string }
  | { kind: "file"; file: LibFile; channel?: Channel; key: string };

const dirOf = (path: string): string => {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i < 0 ? "" : path.slice(0, i);
};

const stemOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

/** Power of two in [256, 16384] — a plausible texture resolution token. */
function isResolution(tok: string): number | null {
  if (/^\d{1,2}k$/i.test(tok)) return parseInt(tok, 10) * 1024;
  if (!/^\d+$/.test(tok)) return null;
  const n = Number(tok);
  if (n < 256 || n > 16384) return null;
  return (n & (n - 1)) === 0 ? n : null;
}

/**
 * Split a stem into tokens on separators and camelCase boundaries.
 * `ORMTexture` → [ORM, Texture] via the ([A-Z]+)([A-Z][a-z]) rule.
 */
export function tokenize(stem: string): string[] {
  return stem
    .replace(/\.\d{3}$/, "") // Blender dupe: exactly three digits, first
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[_\-. ]+/)
    .filter((t) => t.length > 0);
}

/** Longest n-gram (3→2→1) matching the tail of `toks`, or null. */
function matchSuffix(toks: string[]): { rule: (typeof SUFFIX_RULES)[number]; len: number } | null {
  for (let n = 3; n >= 1; n--) {
    if (toks.length < n) continue;
    const window = toks.slice(toks.length - n).map((t) => t.toLowerCase());
    for (const rule of SUFFIX_RULES) {
      if (rule.tokens.length !== n) continue;
      if (rule.tokens.every((t, i) => t === window[i])) return { rule, len: n };
    }
  }
  return null;
}

/**
 * Stage A — per file, name only. Emits candidates, not answers.
 *
 * The trailing-window rule: scan right-to-left, and a token is a suffix
 * candidate only if everything to its right is already suffix or noise. Stop
 * at the first stem token. That is what makes `T_Normal_Wall_D.png` yield key
 * `t_normal_wall` + Diffuse instead of matching the leading `Normal` — a
 * left-to-right or "contains" matcher gets this wrong.
 */
export function parse(file: LibFile): Parsed {
  let toks = tokenize(stemOf(file.name));
  const candidates: Candidate[] = [];
  let convention: NormalConvention | undefined;
  let resolutionToken: number | undefined;

  // Peel the trailing window.
  for (;;) {
    if (toks.length <= 1) break; // never consume the whole name

    const last = toks[toks.length - 1]!.toLowerCase();

    // Noise and resolution tokens are transparent — keep peeling past them.
    const res = isResolution(last);
    if (res !== null) {
      resolutionToken = res;
      toks = toks.slice(0, -1);
      continue;
    }
    if (NOISE_TOKENS.has(last)) {
      toks = toks.slice(0, -1);
      continue;
    }
    if (/^lod\d*$/.test(last)) {
      toks = toks.slice(0, -1);
      continue;
    }

    const hit = matchSuffix(toks);
    if (hit !== null) {
      candidates.push({
        channel: hit.rule.channel,
        confidence: hit.rule.confidence,
        convention: hit.rule.convention,
      });
      if (hit.rule.convention !== undefined) convention = hit.rule.convention;
      toks = toks.slice(0, toks.length - hit.len);
      break; // one channel per file
    }

    const amb = AMBIGUOUS[last];
    if (amb !== undefined) {
      for (const c of amb) candidates.push({ ...c });
      toks = toks.slice(0, -1);
      break;
    }

    break; // a stem token — the window is closed
  }

  // Strip noise and resolution tokens ANYWHERE in the remaining stem, not
  // just off the tail. Both orders occur in the wild — `rock_wall_nor_gl_4k`
  // puts the resolution last (the peel loop catches it), but `rock_4k_diff`
  // puts it before the channel suffix, and the peel loop stops at the first
  // suffix match. Substance's "Mixed" in `$mesh_Mixed_AO` is the same shape.
  const keyTokens: string[] = [];
  for (const t of toks) {
    const low = t.toLowerCase();
    if (NOISE_TOKENS.has(low)) continue;
    const res = isResolution(low);
    if (res !== null) {
      resolutionToken ??= res;
      continue;
    }
    keyTokens.push(low);
  }
  const display = toks
    .filter((t, i) => !(i === 0 && DISPLAY_PREFIXES.has(t.toLowerCase())))
    .filter((t) => !NOISE_TOKENS.has(t.toLowerCase()) && isResolution(t.toLowerCase()) === null)
    .join(" ");

  return {
    file,
    keyTokens: keyTokens.length > 0 ? keyTokens : [stemOf(file.name).toLowerCase()],
    display: display !== "" ? display : stemOf(file.name),
    candidates,
    convention,
    resolutionToken,
  };
}

/** table.ts's 23 channels folded onto the filter vocabulary of 10 (types.ts). */
const GROUP_OF: Record<Channel, ChannelGroup> = {
  baseColor: "baseColor",
  normal: "normal",
  roughness: "roughness",
  smoothness: "roughness",
  gloss: "roughness",
  metallic: "metallic",
  ao: "ao",
  height: "height",
  emissive: "emissive",
  opacity: "opacity",
  packedORM: "packed",
  packedARM: "packed",
  packedRMA: "packed",
  packedMRA: "packed",
  packedUnityMask: "packed",
  packedMetalSmooth: "packed",
  specular: "other",
  curvature: "other",
  cavity: "other",
  subsurface: "other",
  sheen: "other",
  transmission: "other",
  unknown: "other",
};

// Pure function of the name; cached by the ORIGINAL-CASED name at module level
// so the tokenizer runs once per distinct name per session, never per
// keystroke. Not nameLower: tokenize() splits on camelCase boundaries, so
// `RockNormal.png` and `rocknormal.png` classify differently and must not
// share a cache slot.
const groupCache = new Map<string, ChannelGroup>();

/**
 * Stage-A per-file only — the joint pass is NOT run, so `Rock_A.png` filters
 * as its solo best guess and the ambiguous tail lands on `other` (itself a
 * selectable chip). Acceptable for a filter; the grouped view still resolves
 * jointly.
 */
export function channelGroupOf(file: LibFile): ChannelGroup {
  const hit = groupCache.get(file.name);
  if (hit !== undefined) return hit;
  const cands = parse(file).candidates;
  let best: Candidate | null = null;
  for (const c of cands) if (best === null || c.confidence > best.confidence) best = c;
  const group = best === null ? "other" : GROUP_OF[best.channel];
  groupCache.set(file.name, group);
  return group;
}

/**
 * Stage C — solve one group's ambiguities against sibling evidence + content.
 *
 * Content SUPPLEMENTS the name; it never overrides a pinned name match.
 */
function resolveGroup(parsed: Parsed[], stats: Map<number, ThumbInfo>): Member[] {
  // 1. Pin every unambiguous candidate. These are the evidence.
  const evidence = new Set<Channel>();
  for (const p of parsed) {
    const top = p.candidates[0];
    if (top !== undefined && p.candidates.length === 1 && top.confidence >= 0.9) {
      evidence.add(top.channel);
    }
  }
  const hasAlbedoFamily = evidence.has("baseColor");

  return parsed.map((p): Member => {
    const info = stats.get(p.file.id);

    // No suffix at all. A blue-dominant image is a normal map whatever the name
    // (or lack of one) says — check content BEFORE the implicit-base-color rule,
    // or a normal map named `Rock.png` next to `Rock_Color.png` gets miscalled
    // base color and both fight over the same slot.
    if (p.candidates.length === 0) {
      if (info?.normalLike === true) {
        return { ...p, channel: "normal", resolved: 0.8, byContent: true };
      }
      // No suffix + a suffixed sibling → implicit base color. Unity and Unreal
      // exporters do this constantly (Wood.png + Wood_N.png).
      const implicit = parsed.some((q) => q !== p && q.candidates.length > 0);
      if (implicit && (info === undefined || !info.grayscale)) {
        return { ...p, channel: "baseColor", resolved: 0.7, byContent: info !== undefined };
      }
      return { ...p, channel: "unknown", resolved: 0.3 };
    }

    // Unambiguous name → done. The name is the author's intent.
    if (p.candidates.length === 1 && p.candidates[0]!.confidence >= 0.9) {
      return { ...p, channel: p.candidates[0]!.channel, resolved: p.candidates[0]!.confidence };
    }

    // Ambiguous: the joint pass. Content breaks ties the name cannot.
    let best = p.candidates[0]!;
    let resolved = best.confidence;
    let byContent = false;

    if (info?.normalLike === true) {
      // A blue-dominant image is a normal map whatever the letter says.
      return { ...p, channel: "normal", resolved: 0.85, byContent: true };
    }

    for (const c of p.candidates) {
      let score = c.confidence;
      // Sibling constraint: a channel already pinned by a sibling is taken.
      if (evidence.has(c.channel)) score *= 0.25;
      // Content constraints.
      if (info !== undefined) {
        if (c.channel === "baseColor") score *= info.grayscale ? 0.2 : 1.6;
        if (c.channel === "opacity") score *= info.bimodal ? 2.0 : 0.4;
        if (c.channel === "ao" || c.channel === "roughness" || c.channel === "height") {
          score *= info.grayscale ? 1.5 : 0.3;
        }
        byContent = true;
      }
      // `_A` with no albedo sibling is almost always Albedo.
      if (c.channel === "baseColor" && !hasAlbedoFamily) score *= 1.4;
      if (score > resolved) {
        best = c;
        resolved = score;
      }
    }
    return {
      ...p,
      channel: best.channel,
      resolved: Math.min(0.85, resolved),
      byContent,
    };
  });
}

/**
 * Group texture files into materials.
 *
 * Grouped by (dir, key) — the directory is MANDATORY. Group by stem alone and
 * `rock_D.png` from two different packs silently merge into one wrong material.
 */
export function groupTextures(files: readonly LibFile[], stats: Map<number, ThumbInfo>): TextureItem[] {
  const buckets = new Map<string, Parsed[]>();
  const order: string[] = [];

  for (const f of files) {
    const p = parse(f);
    const key = `${dirOf(f.path).toLowerCase()} ${p.keyTokens.join("_")}`;
    let b = buckets.get(key);
    if (b === undefined) {
      b = [];
      buckets.set(key, b);
      order.push(key);
    }
    b.push(p);
  }

  const items: TextureItem[] = [];
  for (const key of order) {
    const group = buckets.get(key)!;

    // A group of one with no recognized suffix is just a texture. So is a
    // group of one WITH a suffix — a lone `Rock_N.png` is not a material,
    // it's a normal map. Two or more sharing a key is a material.
    if (group.length < 2) {
      const p = group[0]!;
      const only = p.candidates[0];
      items.push({
        kind: "file",
        file: p.file,
        channel: only !== undefined && only.confidence >= 0.9 ? only.channel : undefined,
        key: p.file.path,
      });
      continue;
    }

    const members = resolveGroup(group, stats);
    const channels = new Map<Channel, Member>();
    const variants: Member[] = [];
    for (const m of members) {
      if (m.channel === "unknown") continue;
      const prev = channels.get(m.channel);
      if (prev === undefined) {
        channels.set(m.channel, m);
      } else if (m.resolved > prev.resolved) {
        // Higher confidence wins the slot; the loser becomes a variant
        // (resolution ladders and LOD tiers land here by design).
        channels.set(m.channel, m);
        variants.push(prev);
      } else {
        variants.push(m);
      }
    }

    // Every member landed on "unknown" — not a material, just files that
    // happen to share a stem.
    if (channels.size === 0) {
      for (const m of members) {
        items.push({ kind: "file", file: m.file, key: m.file.path });
      }
      continue;
    }

    const first = members[0]!;
    items.push({
      kind: "material",
      key,
      material: {
        key,
        dir: dirOf(first.file.path),
        display: first.display,
        members,
        channels,
        variants,
        confidence: Math.min(...[...channels.values()].map((m) => m.resolved)),
        convention: members.find((m) => m.convention !== undefined)?.convention,
      },
    });
  }
  return items;
}
