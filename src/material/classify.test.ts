/**
 * The material classifier's test suite.
 *
 * Every filename here is a real vendor convention, not an invented one:
 * ambientCG, Quixel Megascans, Synty, Unreal, Unity, Substance, Blender.
 * This is the one piece of the app whose correctness is not visually obvious,
 * and the only automated test in the repo — keep it that way on purpose.
 */
import { describe, expect, it } from "vitest";
import { groupTextures, parse, tokenize, type TextureItem } from "./classify";
import type { LibFile } from "../stores/libraryStore";
import type { ThumbInfo } from "../types";

let nextId = 1;
function f(path: string): LibFile {
  const name = path.split(/[\\/]/).pop()!;
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return {
    id: nextId++,
    path,
    name,
    ext,
    kind: "texture",
    size: 1024,
    modified: 0,
    nameLower: name.toLowerCase(),
  };
}

const DIR = "C:\\Pack";
const at = (n: string): LibFile => f(`${DIR}\\${n}`);

const info = (o: Partial<ThumbInfo>): ThumbInfo => ({
  width: 256,
  height: 256,
  sourceWidth: 1024,
  sourceHeight: 1024,
  normalLike: false,
  grayscale: false,
  bimodal: false,
  hasAlpha: false,
  meanR: 0.5,
  meanG: 0.5,
  meanB: 0.5,
  ...o,
});

/** Channel assigned to `name` within a group of `names`. */
function channelOf(names: string[], name: string, stats = new Map<number, ThumbInfo>()): string {
  const files = names.map(at);
  const items = groupTextures(files, stats);
  for (const it of items) {
    if (it.kind !== "material") continue;
    const m = it.material.members.find((x) => x.file.name === name);
    if (m) return m.channel;
  }
  const lone = items.find((i) => i.kind === "file" && i.file.name === name);
  return lone !== undefined && lone.kind === "file" ? (lone.channel ?? "none") : "none";
}

describe("tokenize", () => {
  it("splits separators and camelCase", () => {
    expect(tokenize("Rock_Wall-02.Base Color")).toEqual(["Rock", "Wall", "02", "Base", "Color"]);
  });
  it("splits an acronym followed by a word (ORMTexture -> ORM + Texture)", () => {
    expect(tokenize("ORMTexture")).toEqual(["ORM", "Texture"]);
  });
  it("strips the Blender dupe suffix, but only exactly three digits", () => {
    expect(tokenize("Rock_D.001")).toEqual(["Rock", "D"]);
    expect(tokenize("Rock_D.01")).toEqual(["Rock", "D", "01"]);
  });
});

describe("resolution tokens", () => {
  it("treats a power of two in range as noise", () => {
    expect(parse(at("rock_4k_diff.jpg")).keyTokens).toEqual(["rock"]);
    expect(parse(at("rock_2048_diff.jpg")).keyTokens).toEqual(["rock"]);
  });
  it("keeps a non-power-of-two as a stem token (Synty's _01 is a variant)", () => {
    // Bias toward KEEPING tokens: splitting one material in two is cosmetic,
    // merging two distinct materials is a wrong answer. `01` is not a power
    // of two, so it survives as identity; `Texture` is noise; and the
    // camelCase rule splits PolygonWestern.
    expect(parse(at("PolygonWestern_Texture_01_A.png")).keyTokens).toEqual([
      "polygon",
      "western",
      "01",
    ]);
  });
});

describe("the trailing-window rule", () => {
  it("does not match a channel word that is part of the stem", () => {
    // A left-to-right or "contains" matcher reads the leading Normal and
    // gets this wrong.
    const p = parse(at("T_Normal_Wall_D.png"));
    expect(p.keyTokens).toEqual(["t", "normal", "wall"]);
    expect(p.candidates[0]?.channel).toBe("baseColor");
  });
});

describe("n-gram precedence", () => {
  it("_ambient_occlusion beats _occlusion", () => {
    expect(parse(at("rock_ambient_occlusion.png")).candidates[0]?.channel).toBe("ao");
    expect(parse(at("rock_ambient_occlusion.png")).keyTokens).toEqual(["rock"]);
  });
  it("_normal_gl beats _normal and records the convention", () => {
    const p = parse(at("rock_wall_02_nor_gl_4k.exr"));
    expect(p.candidates[0]?.channel).toBe("normal");
    expect(p.convention).toBe("gl");
    expect(p.keyTokens).toEqual(["rock", "wall", "02"]);
  });
  it("packed ORM is never read as o + r + m", () => {
    expect(parse(at("T_Brick_ORM.png")).candidates[0]?.channel).toBe("packedORM");
  });
  it("_A does not eat _AO — token splitting makes it structurally impossible", () => {
    expect(parse(at("Rock_AO.png")).candidates[0]?.channel).toBe("ao");
  });
});

describe("joint resolution — the central insight", () => {
  it("_A alone with no constraining sibling is Base Color", () => {
    expect(channelOf(["Rock_A.png", "Rock_N.png"], "Rock_A.png")).toBe("baseColor");
  });

  it("_A next to _D is NOT Base Color — _D pins Diffuse, so _A must be something else", () => {
    // This is the whole point. The same file, same name, different answer,
    // decided by a sibling. A per-file classifier cannot do this.
    const stats = new Map<number, ThumbInfo>();
    const files = [at("Rock_D.png"), at("Rock_A.png")];
    stats.set(files[1]!.id, info({ grayscale: true }));
    const items = groupTextures(files, stats);
    const mat = items.find((i): i is Extract<TextureItem, { kind: "material" }> => i.kind === "material");
    expect(mat).toBeDefined();
    const a = mat!.material.members.find((m) => m.file.name === "Rock_A.png")!;
    expect(a.channel).not.toBe("baseColor");
    expect(["ao", "opacity"]).toContain(a.channel);
  });

  it("content overrides an ambiguous letter: blue-dominant is a normal map", () => {
    const files = [at("Rock_D.png"), at("Rock_N.png")];
    const stats = new Map([[files[1]!.id, info({ normalLike: true })]]);
    const items = groupTextures(files, stats);
    const mat = items.find((i): i is Extract<TextureItem, { kind: "material" }> => i.kind === "material")!;
    expect(mat.material.members.find((m) => m.file.name === "Rock_N.png")!.channel).toBe("normal");
  });

  it("an unsuffixed file beside suffixed siblings is implicit Base Color", () => {
    expect(channelOf(["Wood.png", "Wood_N.png"], "Wood.png")).toBe("baseColor");
  });
});

describe("real vendor packs", () => {
  it("ambientCG: diff/nor_gl/arm/disp group into one material", () => {
    const items = groupTextures(
      [
        at("rock_wall_02_diff_4k.jpg"),
        at("rock_wall_02_nor_gl_4k.exr"),
        at("rock_wall_02_arm_4k.jpg"),
        at("rock_wall_02_disp_4k.png"),
      ],
      new Map(),
    );
    const mats = items.filter((i) => i.kind === "material");
    expect(mats).toHaveLength(1);
    const m = (mats[0] as Extract<TextureItem, { kind: "material" }>).material;
    expect(m.members).toHaveLength(4);
    expect([...m.channels.keys()].sort()).toEqual(["baseColor", "height", "normal", "packedARM"]);
    expect(m.convention).toBe("gl");
  });

  it("Megascans: 2K_Albedo / 2K_Normal_LOD0 / 2K_Roughness group", () => {
    const items = groupTextures(
      [at("sd8fbtag_2K_Albedo.jpg"), at("sd8fbtag_2K_Normal_LOD0.jpg"), at("sd8fbtag_2K_Roughness.jpg")],
      new Map(),
    );
    const mats = items.filter((i) => i.kind === "material");
    expect(mats).toHaveLength(1);
    expect((mats[0] as Extract<TextureItem, { kind: "material" }>).material.members).toHaveLength(3);
  });

  it("Unreal: T_Brick_D / _N / _ORM group, display drops the T_ prefix", () => {
    const items = groupTextures([at("T_Brick_D.png"), at("T_Brick_N.png"), at("T_Brick_ORM.png")], new Map());
    const m = (items.find((i) => i.kind === "material") as Extract<TextureItem, { kind: "material" }>).material;
    expect([...m.channels.keys()].sort()).toEqual(["baseColor", "normal", "packedORM"]);
    expect(m.display).toBe("Brick");
  });

  it("Substance: Mixed is noise, so Material_Mixed_AO joins Material_Base_Color", () => {
    const items = groupTextures([at("Material_Mixed_AO.png"), at("Material_Base_Color.png")], new Map());
    const mats = items.filter((i) => i.kind === "material");
    expect(mats).toHaveLength(1);
    expect((mats[0] as Extract<TextureItem, { kind: "material" }>).material.members).toHaveLength(2);
  });

  it("Synty: BaseGrass_normals.png — the PLURAL form real packs actually ship", () => {
    expect(parse(at("BaseGrass_normals.png")).candidates[0]?.channel).toBe("normal");
  });

  it("Blender dupes collapse onto the original", () => {
    const items = groupTextures([at("Rock_D.png"), at("Rock_D.001.png"), at("Rock_N.png")], new Map());
    const m = (items.find((i) => i.kind === "material") as Extract<TextureItem, { kind: "material" }>).material;
    expect(m.members).toHaveLength(3);
    // Two files claim baseColor; one wins the slot, the other is a variant.
    expect(m.variants).toHaveLength(1);
  });
});

describe("guardrails", () => {
  it("never groups across directories — two packs' rock_D are two materials", () => {
    const items = groupTextures([f("C:\\PackA\\rock_D.png"), f("C:\\PackB\\rock_D.png")], new Map());
    expect(items.filter((i) => i.kind === "material")).toHaveLength(0);
    expect(items.filter((i) => i.kind === "file")).toHaveLength(2);
  });

  it("a lone texture is not a material", () => {
    const items = groupTextures([at("Cliffwall.png")], new Map());
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("file");
  });

  it("a lone suffixed file is a normal map, not a one-member material", () => {
    const items = groupTextures([at("Rock_N.png")], new Map());
    expect(items[0]!.kind).toBe("file");
    expect(items[0]!.kind === "file" && items[0]!.channel).toBe("normal");
  });

  it("does not invent a channel from a stem that merely ends in a letter", () => {
    // "banana" must not strip to "banan" + Alpha. We never substring-strip;
    // only whole tokens match.
    const p = parse(at("banana.png"));
    expect(p.candidates).toHaveLength(0);
    expect(p.keyTokens).toEqual(["banana"]);
  });

  it("Synty variants stay distinct materials, not one merged blob", () => {
    // Grass_01..04 are four different textures. Over-stripping _01 would merge
    // them into one wrong material.
    const items = groupTextures(
      [at("Grass_01.png"), at("Grass_02.png"), at("Grass_03.png"), at("Grass_04.png")],
      new Map(),
    );
    expect(items.filter((i) => i.kind === "file")).toHaveLength(4);
  });
});
