/**
 * The channel-suffix vocabulary.
 *
 * Matched as TOKEN N-GRAMS, right-to-left, n = 3 → 2 → 1, first hit wins.
 * N-grams (not substrings) are what make `_ambient_occlusion` beat
 * `_occlusion`, and `_normal_gl` beat `_normal` + a stray `gl`.
 *
 * Token splitting also kills the "`_A` eats `_AO`" worry outright:
 * `Rock_AO.png` tokenizes to [rock, ao], `ao` is a whole token, and `a` never
 * gets a look-in.
 */

export type Channel =
  | "baseColor"
  | "normal"
  | "roughness"
  | "metallic"
  | "smoothness"
  | "gloss"
  | "specular"
  | "ao"
  | "height"
  | "emissive"
  | "opacity"
  | "curvature"
  | "cavity"
  | "subsurface"
  | "sheen"
  | "transmission"
  | "packedORM"
  | "packedARM"
  | "packedRMA"
  | "packedMRA"
  | "packedUnityMask"
  | "packedMetalSmooth"
  | "unknown";

export const CHANNEL_LABEL: Record<Channel, string> = {
  baseColor: "Base Color",
  normal: "Normal",
  roughness: "Roughness",
  metallic: "Metallic",
  smoothness: "Smoothness",
  gloss: "Gloss",
  specular: "Specular",
  ao: "Ambient Occlusion",
  height: "Height",
  emissive: "Emissive",
  opacity: "Opacity",
  curvature: "Curvature",
  cavity: "Cavity",
  subsurface: "Subsurface",
  sheen: "Sheen",
  transmission: "Transmission",
  packedORM: "Packed ORM",
  packedARM: "Packed ARM",
  packedRMA: "Packed RMA",
  packedMRA: "Packed MRA",
  packedUnityMask: "Unity Mask Map",
  packedMetalSmooth: "Metallic/Smoothness",
  unknown: "Unclassified",
};

/** Compact code for the channel strip on a grid cell. */
export const CHANNEL_CODE: Record<Channel, string> = {
  baseColor: "BC",
  normal: "N",
  roughness: "R",
  metallic: "M",
  smoothness: "S",
  gloss: "G",
  specular: "SP",
  ao: "AO",
  height: "H",
  emissive: "E",
  opacity: "OP",
  curvature: "CV",
  cavity: "CA",
  subsurface: "SSS",
  sheen: "SH",
  transmission: "TR",
  packedORM: "ORM",
  packedARM: "ARM",
  packedRMA: "RMA",
  packedMRA: "MRA",
  packedUnityMask: "MASK",
  packedMetalSmooth: "MS",
  unknown: "?",
};

/** The channels a grid cell's strip shows, in order. */
export const STRIP_CHANNELS: Channel[] = [
  "baseColor",
  "normal",
  "roughness",
  "metallic",
  "ao",
  "height",
];

export type NormalConvention = "gl" | "dx";

export interface SuffixRule {
  /** Token n-gram, already lowercase. */
  tokens: string[];
  channel: Channel;
  /** >= 0.9 counts as pinned evidence for the joint pass. */
  confidence: number;
  convention?: NormalConvention;
}

/**
 * Ordered longest-n-gram-first within each group. PACKED FIRST so `orm` can
 * never be read as o + r + m.
 */
export const SUFFIX_RULES: SuffixRule[] = [
  // ---- packed ----
  { tokens: ["occlusion", "roughness", "metallic"], channel: "packedORM", confidence: 0.98 },
  { tokens: ["metallic", "smoothness"], channel: "packedMetalSmooth", confidence: 0.95 },
  // Unity's `_MetallicGlossMap`: metallic in RGB, smoothness (= gloss) in alpha.
  { tokens: ["metallic", "gloss"], channel: "packedMetalSmooth", confidence: 0.92 },
  { tokens: ["mask", "map"], channel: "packedUnityMask", confidence: 0.9 },
  { tokens: ["orm"], channel: "packedORM", confidence: 0.95 },
  { tokens: ["arm"], channel: "packedARM", confidence: 0.95 },
  { tokens: ["rma"], channel: "packedRMA", confidence: 0.95 },
  { tokens: ["mra"], channel: "packedMRA", confidence: 0.95 },
  // GameTextures ships `_MRAO` = Metallic / Roughness / AO — same channel order
  // as MRA, the trailing O is just spelled out.
  { tokens: ["mrao"], channel: "packedMRA", confidence: 0.95 },
  { tokens: ["maskmap"], channel: "packedUnityMask", confidence: 0.9 },
  { tokens: ["metallicsmoothness"], channel: "packedMetalSmooth", confidence: 0.95 },
  { tokens: ["metallicgloss"], channel: "packedMetalSmooth", confidence: 0.92 },

  // ---- qualified "* color" — a 2-gram so the qualifier wins over the bare
  // `color`/`colour` rule below. `Lamp_EmissiveColor` is emissive, not albedo;
  // n=2 is tried before n=1, so these fire first. ----
  { tokens: ["emissive", "color"], channel: "emissive", confidence: 0.97 },
  { tokens: ["emissive", "colour"], channel: "emissive", confidence: 0.97 },
  { tokens: ["emission", "color"], channel: "emissive", confidence: 0.97 },
  { tokens: ["emission", "colour"], channel: "emissive", confidence: 0.97 },
  { tokens: ["specular", "color"], channel: "specular", confidence: 0.96 },
  { tokens: ["specular", "colour"], channel: "specular", confidence: 0.96 },
  { tokens: ["subsurface", "color"], channel: "subsurface", confidence: 0.96 },
  { tokens: ["subsurface", "colour"], channel: "subsurface", confidence: 0.96 },
  { tokens: ["sub", "surface"], channel: "subsurface", confidence: 0.95 },
  { tokens: ["subsurface", "scattering"], channel: "subsurface", confidence: 0.96 },

  // ---- base color ----
  { tokens: ["base", "color"], channel: "baseColor", confidence: 0.98 },
  { tokens: ["base", "colour"], channel: "baseColor", confidence: 0.98 },
  { tokens: ["base", "col"], channel: "baseColor", confidence: 0.95 },
  { tokens: ["main", "tex"], channel: "baseColor", confidence: 0.95 },
  { tokens: ["basecolor"], channel: "baseColor", confidence: 0.98 },
  { tokens: ["basecolour"], channel: "baseColor", confidence: 0.98 },
  { tokens: ["albedo"], channel: "baseColor", confidence: 0.98 },
  { tokens: ["diffuse"], channel: "baseColor", confidence: 0.97 },
  { tokens: ["diff"], channel: "baseColor", confidence: 0.95 },
  { tokens: ["dif"], channel: "baseColor", confidence: 0.9 },
  { tokens: ["alb"], channel: "baseColor", confidence: 0.92 },
  { tokens: ["maintex"], channel: "baseColor", confidence: 0.95 },
  { tokens: ["basemap"], channel: "baseColor", confidence: 0.9 },
  { tokens: ["basecol"], channel: "baseColor", confidence: 0.92 },
  { tokens: ["color"], channel: "baseColor", confidence: 0.85 },
  { tokens: ["colour"], channel: "baseColor", confidence: 0.85 },
  { tokens: ["col"], channel: "baseColor", confidence: 0.85 },
  { tokens: ["bc"], channel: "baseColor", confidence: 0.8 },
  { tokens: ["d"], channel: "baseColor", confidence: 0.9 },

  // ---- normal. Plural forms are real: Synty ships BaseGrass_normals.png. ----
  { tokens: ["normal", "opengl"], channel: "normal", confidence: 0.98, convention: "gl" },
  { tokens: ["normal", "directx"], channel: "normal", confidence: 0.98, convention: "dx" },
  { tokens: ["normal", "gl"], channel: "normal", confidence: 0.98, convention: "gl" },
  { tokens: ["normal", "dx"], channel: "normal", confidence: 0.98, convention: "dx" },
  { tokens: ["normal", "ogl"], channel: "normal", confidence: 0.98, convention: "gl" },
  { tokens: ["nor", "gl"], channel: "normal", confidence: 0.98, convention: "gl" },
  { tokens: ["nor", "dx"], channel: "normal", confidence: 0.98, convention: "dx" },
  { tokens: ["nor", "ogl"], channel: "normal", confidence: 0.98, convention: "gl" },
  { tokens: ["nrm", "gl"], channel: "normal", confidence: 0.98, convention: "gl" },
  { tokens: ["nrm", "dx"], channel: "normal", confidence: 0.98, convention: "dx" },
  { tokens: ["normal", "map"], channel: "normal", confidence: 0.98 },
  { tokens: ["normal", "bump"], channel: "normal", confidence: 0.95 }, // Megascans _NormalBump
  { tokens: ["bump", "map"], channel: "normal", confidence: 0.9 },
  { tokens: ["normalgl"], channel: "normal", confidence: 0.98, convention: "gl" },
  { tokens: ["normaldx"], channel: "normal", confidence: 0.98, convention: "dx" },
  { tokens: ["normalmap"], channel: "normal", confidence: 0.98 },
  { tokens: ["normals"], channel: "normal", confidence: 0.98 },
  { tokens: ["nrm16"], channel: "normal", confidence: 0.95 }, // Poliigon 16-bit
  { tokens: ["normal"], channel: "normal", confidence: 0.98 },
  { tokens: ["bumpmap"], channel: "normal", confidence: 0.9 },
  { tokens: ["norm"], channel: "normal", confidence: 0.96 },
  { tokens: ["nrml"], channel: "normal", confidence: 0.96 },
  { tokens: ["nrm"], channel: "normal", confidence: 0.96 },
  { tokens: ["nor"], channel: "normal", confidence: 0.95 },
  { tokens: ["nml"], channel: "normal", confidence: 0.9 },
  { tokens: ["nmap"], channel: "normal", confidence: 0.95 }, // Fab importer
  { tokens: ["n"], channel: "normal", confidence: 0.9 },

  // ---- roughness / gloss / specular ----
  { tokens: ["roughness"], channel: "roughness", confidence: 0.98 },
  { tokens: ["rough"], channel: "roughness", confidence: 0.96 },
  { tokens: ["rgh"], channel: "roughness", confidence: 0.9 },
  { tokens: ["rou"], channel: "roughness", confidence: 0.9 }, // Fab importer
  { tokens: ["smoothness"], channel: "smoothness", confidence: 0.97 },
  { tokens: ["smooth"], channel: "smoothness", confidence: 0.9 },
  { tokens: ["glossiness"], channel: "gloss", confidence: 0.97 },
  { tokens: ["gloss"], channel: "gloss", confidence: 0.95 },
  { tokens: ["specular"], channel: "specular", confidence: 0.97 },
  { tokens: ["spec"], channel: "specular", confidence: 0.95 },
  // Specular/gloss workflow: Poliigon's legacy `_REFL` reflection map.
  { tokens: ["reflection"], channel: "specular", confidence: 0.85 },
  { tokens: ["refl"], channel: "specular", confidence: 0.8 },

  // ---- metallic ----
  { tokens: ["metallic"], channel: "metallic", confidence: 0.98 },
  { tokens: ["metalness"], channel: "metallic", confidence: 0.98 },
  { tokens: ["metallness"], channel: "metallic", confidence: 0.97 },
  { tokens: ["metalic"], channel: "metallic", confidence: 0.95 }, // common misspelling
  { tokens: ["metal"], channel: "metallic", confidence: 0.95 },
  { tokens: ["mtl"], channel: "metallic", confidence: 0.9 },
  { tokens: ["met"], channel: "metallic", confidence: 0.9 },

  // ---- ambient occlusion ----
  { tokens: ["ambient", "occlusion"], channel: "ao", confidence: 0.98 },
  { tokens: ["ambientocclusion"], channel: "ao", confidence: 0.98 },
  { tokens: ["occlusion"], channel: "ao", confidence: 0.97 },
  { tokens: ["ao"], channel: "ao", confidence: 0.97 },
  { tokens: ["occ"], channel: "ao", confidence: 0.95 },

  // ---- height / displacement ----
  { tokens: ["displacement"], channel: "height", confidence: 0.97 },
  { tokens: ["heightmap"], channel: "height", confidence: 0.97 },
  { tokens: ["displace"], channel: "height", confidence: 0.95 },
  { tokens: ["parallax"], channel: "height", confidence: 0.9 },
  { tokens: ["height"], channel: "height", confidence: 0.97 },
  { tokens: ["disp"], channel: "height", confidence: 0.95 },
  { tokens: ["disp16"], channel: "height", confidence: 0.95 }, // Poliigon 16-bit
  { tokens: ["displ"], channel: "height", confidence: 0.93 }, // Substance/Fab
  { tokens: ["depth"], channel: "height", confidence: 0.8 }, // Godot alias
  // bare "bump" (not "bumpmap") is usually a height field, but weakly.
  { tokens: ["bump"], channel: "height", confidence: 0.7 },

  // ---- emissive ----
  { tokens: ["emissive"], channel: "emissive", confidence: 0.98 },
  { tokens: ["emission"], channel: "emissive", confidence: 0.98 },
  { tokens: ["emit"], channel: "emissive", confidence: 0.95 },
  { tokens: ["glow"], channel: "emissive", confidence: 0.85 },

  // ---- opacity ----
  { tokens: ["transparency"], channel: "opacity", confidence: 0.95 },
  { tokens: ["transparent"], channel: "opacity", confidence: 0.92 },
  { tokens: ["opacity"], channel: "opacity", confidence: 0.97 },
  { tokens: ["opac"], channel: "opacity", confidence: 0.92 },
  { tokens: ["cutout"], channel: "opacity", confidence: 0.9 },
  { tokens: ["alpha"], channel: "opacity", confidence: 0.9 },
  { tokens: ["mask"], channel: "opacity", confidence: 0.75 },

  // ---- subsurface / scattering / translucency ----
  { tokens: ["subsurface"], channel: "subsurface", confidence: 0.95 },
  { tokens: ["scattering"], channel: "subsurface", confidence: 0.85 },
  { tokens: ["translucency"], channel: "subsurface", confidence: 0.9 },
  { tokens: ["translucent"], channel: "subsurface", confidence: 0.85 },
  { tokens: ["sss"], channel: "subsurface", confidence: 0.9 },

  // ---- sheen / fuzz (cloth). Megascans `_Fuzz`, Poliigon `_SheenColor`. ----
  { tokens: ["sheen", "color"], channel: "sheen", confidence: 0.95 },
  { tokens: ["sheen", "colour"], channel: "sheen", confidence: 0.95 },
  { tokens: ["sheen"], channel: "sheen", confidence: 0.93 },
  { tokens: ["fuzz"], channel: "sheen", confidence: 0.92 },

  // ---- transmission (glass). Megascans/Poliigon `_Transmission`. ----
  { tokens: ["transmission"], channel: "transmission", confidence: 0.95 },
  { tokens: ["transmittance"], channel: "transmission", confidence: 0.9 },

  // ---- misc ----
  { tokens: ["curvature"], channel: "curvature", confidence: 0.95 },
  { tokens: ["cavity"], channel: "cavity", confidence: 0.95 },
  { tokens: ["curv"], channel: "curvature", confidence: 0.9 },
];

/**
 * Single letters and short forms with NO defensible per-file answer.
 *
 * These emit a candidate SET; only the joint pass may collapse it. This table
 * existing at all is the design's whole point: `Rock_A.png` alone is
 * undecidable — Albedo, Alpha, or AO? — but `Rock_A.png` NEXT TO `Rock_D.png`
 * is decidable, because `_D` is unambiguously Diffuse.
 */
export const AMBIGUOUS: Record<string, { channel: Channel; confidence: number }[]> = {
  a: [
    { channel: "baseColor", confidence: 0.4 },
    { channel: "ao", confidence: 0.3 },
    { channel: "opacity", confidence: 0.3 },
  ],
  s: [
    { channel: "specular", confidence: 0.5 },
    { channel: "smoothness", confidence: 0.5 },
  ],
  g: [{ channel: "gloss", confidence: 0.6 }],
  m: [
    { channel: "metallic", confidence: 0.7 },
    { channel: "opacity", confidence: 0.3 },
  ],
  o: [
    { channel: "ao", confidence: 0.6 },
    { channel: "opacity", confidence: 0.4 },
  ],
  r: [{ channel: "roughness", confidence: 0.85 }],
  h: [{ channel: "height", confidence: 0.85 }],
  c: [
    { channel: "baseColor", confidence: 0.6 },
    { channel: "cavity", confidence: 0.4 },
  ],
  e: [{ channel: "emissive", confidence: 0.75 }],
  // GameTextures' legacy game format: `_T` is transparency. Low prior — a lone
  // `_T` could be a variant letter — so only a sibling can promote it.
  t: [{ channel: "opacity", confidence: 0.5 }],
  ms: [{ channel: "packedMetalSmooth", confidence: 0.6 }],
};

/**
 * Stripped ANYWHERE in the stem, not just the trailing window. `mixed` is
 * Substance's `$mesh_Mixed_AO`; without it that file keys as `material_mixed`
 * and never joins `Material_Base_Color`.
 */
export const NOISE_TOKENS = new Set([
  "tex",
  "texture",
  "textures",
  "map",
  "img",
  "image",
  "final",
  "export",
  "bake",
  "baked",
  "mixed",
]);

/** Leading type prefixes: stripped for DISPLAY only, never for the key.
 *  `T_Rock_D` and `Rock_D` in one folder are genuinely different assets. */
export const DISPLAY_PREFIXES = new Set(["t", "tex", "m", "mi", "tx"]);

/** Packed layouts, so the inspector can name what sits in each channel. */
export const PACKED_LAYOUT: Partial<Record<Channel, [string, string, string]>> = {
  packedORM: ["AO", "Roughness", "Metallic"],
  packedARM: ["AO", "Roughness", "Metallic"],
  packedRMA: ["Roughness", "Metallic", "AO"],
  packedMRA: ["Metallic", "Roughness", "AO"],
  packedUnityMask: ["Metallic", "AO", "Detail"],
};
