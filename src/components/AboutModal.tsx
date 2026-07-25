import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import clsx from "clsx";
import { Check, ChevronRight, Copy, Search, X } from "lucide-react";
import { APP_NAME, BUILD, REPO_URL } from "../buildInfo";

/** One row of src/generated/thirdParty.json. Keys are short because the file
 *  ships in the binary; see scripts/gen-third-party.ps1. */
interface Component {
  n: string;
  v: string;
  /** The declared SPDX expression, canonicalized but never narrowed. */
  l: string;
  /** Obligation class derived from `l` — what the chips group on. */
  c: string;
  e: string;
  /** Index into thirdPartyTexts.json, or -1 when the package ships no license
   *  file (its manifest SPDX id governs instead). */
  t: number;
}

interface Meta {
  count: number;
  textCount: number;
  classes: { class: string; count: number }[];
  summary: { license: string; count: number }[];
  components: Component[];
}

type Tab = "about" | "licenses";

function Row({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex items-baseline gap-3 py-1">
      <span className="w-16 shrink-0 text-[11px] text-faint">{label}</span>
      <span className="min-w-0 flex-1 select-text break-all font-mono text-[11px] text-text">
        {value}
      </span>
    </div>
  );
}

function SectionLabel({ children }: { children: string }): ReactElement {
  return (
    <div className="mb-2 mt-5 text-[10px] font-medium uppercase tracking-wide text-faint first:mt-0">
      {children}
    </div>
  );
}

/**
 * "About…" modal (SettingsMenu): the build stamp, the licence the app ships
 * under, and the third-party attributions the MIT/Apache-2.0 notices require.
 *
 * Two tabs rather than one long column, because the attributions are 623 rows
 * and burying the build stamp above them makes the thing people actually open
 * this for the hardest to reach. Each tab owns exactly ONE scroll container —
 * an earlier version nested a scrolling <pre> inside the scrolling body, which
 * traps the wheel as soon as the pointer crosses into it.
 *
 * Data loads in two stages, both lazily (see scripts/gen-third-party.ps1):
 * ~50 KB of component rows when the Licenses tab is first opened, and the ~2 MB
 * of deduped licence texts only once someone expands an individual component.
 * Embedding rather than reading a sidecar file means the notices travel even in
 * the portable single-exe build, which has no installer to place a file beside.
 */
export default function AboutModal({ onClose }: { onClose: () => void }): ReactElement {
  const [tab, setTab] = useState<Tab>("about");
  const [copied, setCopied] = useState(false);

  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState(false);
  const [texts, setTexts] = useState<string[] | null>(null);

  const [query, setQuery] = useState("");
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    // Capture phase: beat the global shortcut handler (StatsModal idiom).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Fetch the component list the first time the tab is shown, not on mount:
  // most opens of this dialog only ever look at the build stamp.
  useEffect(() => {
    if (tab !== "licenses" || meta !== null) return;
    let alive = true;
    void import("../generated/thirdParty.json")
      .then((m) => {
        if (alive) setMeta(m.default as Meta);
      })
      .catch((err: unknown) => {
        console.error("failed to load third-party metadata", err);
        if (alive) setMetaError(true);
      });
    return () => {
      alive = false;
    };
  }, [tab, meta]);

  useEffect(() => {
    if (tab === "licenses") searchRef.current?.focus();
  }, [tab]);

  const copySource = (): void => {
    navigator.clipboard
      .writeText(REPO_URL)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch((err: unknown) => {
        console.warn("clipboard write failed", err);
      });
  };

  const expandComponent = (key: string, c: Component): void => {
    setExpanded((cur) => (cur === key ? null : key));
    // Only the first expansion of a component that HAS a text pays the 2 MB.
    if (c.t >= 0 && texts === null) {
      void import("../generated/thirdPartyTexts.json")
        .then((m) => setTexts(m.default as string[]))
        .catch((err: unknown) => {
          console.error("failed to load license texts", err);
          setTexts([]);
        });
    }
  };

  // Chips group by obligation class, not by SPDX string: "Apache-2.0 OR MIT",
  // "Apache-2.0 OR MIT OR Zlib" and "MIT" are five different answers to a
  // question nobody asked, and one answer ("permissive, notice only") to the
  // one they did. The exact expression stays on every row.
  const chips = useMemo(() => (meta === null ? [] : meta.classes), [meta]);

  const TABS: { id: Tab; label: string; count: number | null }[] = [
    { id: "about", label: "Overview", count: null },
    { id: "licenses", label: "Third-party licenses", count: meta?.count ?? null },
  ];

  const visible = useMemo(() => {
    if (meta === null) return [];
    const q = query.trim().toLowerCase();
    return meta.components.filter((c) => {
      if (classFilter !== null && c.c !== classFilter) return false;
      if (q === "") return true;
      return c.n.toLowerCase().includes(q) || c.l.toLowerCase().includes(q);
    });
  }, [meta, query, classFilter]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Fixed height, not content-driven: the dialog must not resize when you
          switch tabs or expand a licence, or the close button moves under the
          cursor mid-read. */}
      <div className="flex h-[600px] max-h-full w-[720px] max-w-full flex-col overflow-hidden rounded-xl bg-raised shadow-e2">
        <div className="flex shrink-0 items-center gap-2 px-4 pt-3">
          <span className="text-[13px] font-medium">About {APP_NAME}</span>
          <span className="rounded-full bg-bg px-2 py-0.5 font-mono text-[10px] tabular-nums text-dim">
            v{BUILD.version}
          </span>
          <button type="button" className="icon-btn ml-auto shrink-0" title="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {/* "Overview", not "About" — a tab repeating the dialog's own title
            reads as though it navigates somewhere else. The count lives in a
            badge rather than parentheses so the label stays a stable width when
            the data finishes loading. */}
        <div className="mt-2 flex shrink-0 gap-1 border-b border-overlay px-3">
          {TABS.map(({ id, label, count }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={clsx(
                "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12px] transition-colors duration-[120ms]",
                tab === id
                  ? "border-accent text-text"
                  : "border-transparent text-dim hover:text-text",
              )}
            >
              {label}
              {count !== null && (
                <span className="rounded-full bg-bg px-1.5 py-0.5 text-[10px] tabular-nums text-faint">
                  {count}
                </span>
              )}
            </button>
          ))}
        </div>

        {tab === "about" ? (
          <div className="facet-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <SectionLabel>Build</SectionLabel>
            <Row label="Version" value={BUILD.version} />
            <Row label="Commit" value={BUILD.commit} />
            <Row label="Built" value={BUILD.date} />
            <div className="flex items-baseline gap-3 py-1">
              <span className="w-16 shrink-0 text-[11px] text-faint">Source</span>
              <span className="min-w-0 flex-1 select-text break-all font-mono text-[11px] text-text">
                {REPO_URL}
              </span>
              {/* Copy rather than a link: the app registers no URL-opener
                  plugin, so an <a> would silently do nothing in the webview. */}
              <button
                type="button"
                className="icon-btn shrink-0"
                title={copied ? "Copied" : "Copy link"}
                onClick={copySource}
              >
                {copied ? <Check size={13} className="text-accent" /> : <Copy size={13} />}
              </button>
            </div>

            <SectionLabel>License</SectionLabel>
            <p className="text-[12px] leading-relaxed text-dim">
              {APP_NAME} is source-available under the{" "}
              <span className="text-text">Game Asset Browser License 1.0.0</span> — use it for any
              purpose including commercial work, build and modify it for your own use, and keep
              full rights to everything you create with it. It may not be redistributed or resold,
              modified or not.
            </p>

            <SectionLabel>Third-party components</SectionLabel>
            <p className="text-[12px] leading-relaxed text-dim">
              This app bundles open-source components under permissive licenses (MIT, Apache-2.0,
              BSD, ISC, Zlib, MPL-2.0). The MPL-2.0 components are used unmodified; their source is
              available from crates.io at the versions listed.
            </p>
            <button
              type="button"
              className="mt-3 rounded-lg bg-bg px-3 py-1.5 text-[12px] text-dim transition-colors duration-[120ms] hover:bg-overlay hover:text-text"
              onClick={() => setTab("licenses")}
            >
              Browse all components →
            </button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Search and filters sit OUTSIDE the scroll area so they stay
                reachable while the list below them scrolls. */}
            <div className="shrink-0 px-4 pb-2 pt-3">
              <div className="relative">
                <Search
                  size={13}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim"
                />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  spellCheck={false}
                  placeholder="Search components…"
                  onChange={(e) => setQuery(e.currentTarget.value)}
                  className="h-8 w-full rounded-lg bg-bg pl-8 pr-3 text-[12px] text-text outline-none placeholder:text-faint focus:ring-1 focus:ring-accent/40"
                />
              </div>
              {chips.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    className={clsx("chip", classFilter === null && "chip-active")}
                    onClick={() => setClassFilter(null)}
                  >
                    All · {meta?.count ?? 0}
                  </button>
                  {chips.map((s) => (
                    <button
                      key={s.class}
                      type="button"
                      className={clsx("chip", classFilter === s.class && "chip-active")}
                      onClick={() => setClassFilter((cur) => (cur === s.class ? null : s.class))}
                    >
                      {s.class} · {s.count}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="facet-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-3">
              {metaError ? (
                <div className="py-6 text-center text-[12px] text-dim">
                  Could not load the attribution data.
                </div>
              ) : meta === null ? (
                <div className="py-6 text-center text-[12px] text-dim">Loading…</div>
              ) : visible.length === 0 ? (
                <div className="py-6 text-center text-[12px] text-dim">
                  No components match “{query}”.
                </div>
              ) : (
                visible.map((c) => {
                  const key = `${c.n}@${c.v}`;
                  const open = expanded === key;
                  return (
                    <div key={key} className="border-b border-overlay/40 last:border-0">
                      {/* Name and version sit together on the left rather than
                          at opposite ends of a 700px row — a version stranded
                          mid-row reads as belonging to nothing. The chevron is
                          the only cue that these rows do anything when clicked. */}
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => expandComponent(key, c)}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-[120ms] hover:bg-overlay"
                      >
                        <ChevronRight
                          size={12}
                          className={clsx(
                            "shrink-0 text-faint transition-transform duration-[120ms]",
                            open && "rotate-90",
                          )}
                        />
                        <span className="min-w-0 truncate text-[12px] text-text">{c.n}</span>
                        <span className="shrink-0 font-mono text-[10px] tabular-nums text-faint">
                          {c.v}
                        </span>
                        <span className="ml-auto max-w-[45%] shrink-0 truncate text-[11px] text-dim">
                          {c.l}
                        </span>
                      </button>
                      {open && (
                        <div className="mb-2 ml-4 border-l-2 border-overlay pl-3">
                          <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">
                            {c.e} · {c.c}
                          </div>
                          {c.t < 0 ? (
                            <p className="text-[11px] leading-relaxed text-dim">
                              Ships no license file. The{" "}
                              <span className="text-text">{c.l}</span> declaration in its manifest
                              governs; the canonical text is the standard text of that license.
                            </p>
                          ) : texts === null ? (
                            <div className="py-2 text-[11px] text-dim">Loading license text…</div>
                          ) : (
                            <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-dim">
                              {texts[c.t] ?? "License text unavailable."}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {meta !== null && (
              <div className="shrink-0 border-t border-overlay px-4 py-2 text-[11px] tabular-nums text-faint">
                {visible.length === meta.count
                  ? `${meta.count} components · ${meta.textCount} distinct license texts`
                  : `${visible.length} of ${meta.count} components`}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
