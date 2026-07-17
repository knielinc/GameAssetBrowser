import * as THREE from "three";

/**
 * Parallax occlusion mapping for a MeshStandardMaterial.
 *
 * WHY, not displacement: `displacementMap` moves vertices along their normals.
 * On a cube the faces share edges as SPLIT vertices (each face has its own
 * normal), so displacing them pulls the faces apart into visible seams — and a
 * height map only shows at all if the mesh is finely tessellated. Parallax
 * instead offsets the TEXTURE LOOKUP per fragment by the view angle and the
 * height field, so the surface reads as deep without a single vertex moving:
 * no seams, works on any mesh, any poly count.
 *
 * Implemented by patching the stock PBR shader in onBeforeCompile so every
 * other map (albedo, normal, roughness, ao, …) is sampled at the SAME
 * parallax-corrected UV — otherwise the depth illusion and the shading would
 * disagree.
 */

const PARALLAX_GLSL = /* glsl */ `
uniform sampler2D uHeightMap;
uniform float uParallaxScale;

// TBN from screen-space derivatives — no tangent attribute needed, same
// approach three uses for derivative normal mapping.
mat3 pomFrame( vec3 N, vec3 p, vec2 uv ) {
  vec3 dp1 = dFdx( p );
  vec3 dp2 = dFdy( p );
  vec2 duv1 = dFdx( uv );
  vec2 duv2 = dFdy( uv );
  vec3 dp2perp = cross( dp2, N );
  vec3 dp1perp = cross( N, dp1 );
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt( max( dot( T, T ), dot( B, B ) ) );
  return mat3( T * invmax, B * invmax, N );
}

// Returns the UV OFFSET (parallax-corrected uv minus the input uv), so callers
// can add it to every map's own varying.
vec2 parallaxOffset( vec2 uv ) {
  if ( uParallaxScale <= 0.0 ) return vec2( 0.0 );
  vec3 N = normalize( vNormal );
  vec3 p = - vViewPosition;
  mat3 TBN = pomFrame( N, p, uv );
  vec3 vTS = normalize( normalize( vViewPosition ) * TBN ); // view dir, tangent space
  float nz = max( abs( vTS.z ), 0.1 );
  // More march steps at grazing angles, where the illusion needs them.
  float numLayers = mix( 32.0, 8.0, abs( vTS.z ) );
  float layerDepth = 1.0 / numLayers;
  vec2 delta = ( vTS.xy / nz ) * uParallaxScale / numLayers;
  float curDepth = 0.0;
  vec2 curUv = uv;
  float h = 1.0 - texture2D( uHeightMap, curUv ).r; // white = high => low depth
  for ( int i = 0; i < 32; i ++ ) {
    if ( curDepth >= h ) break;
    curUv -= delta;
    h = 1.0 - texture2D( uHeightMap, curUv ).r;
    curDepth += layerDepth;
  }
  // Interpolate across the last step for a smooth intersection.
  vec2 prevUv = curUv + delta;
  float after = h - curDepth;
  float before = ( 1.0 - texture2D( uHeightMap, prevUv ).r ) - curDepth + layerDepth;
  float denom = after - before;
  float w = abs( denom ) < 1e-5 ? 0.0 : after / denom;
  return mix( curUv, prevUv, clamp( w, 0.0, 1.0 ) ) - uv;
}
`;

/** Map chunk name -> the UV varying it samples with. */
const MAP_CHUNKS: [chunk: string, uv: string][] = [
  ["map_fragment", "vMapUv"],
  ["alphamap_fragment", "vAlphaMapUv"],
  ["roughnessmap_fragment", "vRoughnessMapUv"],
  ["metalnessmap_fragment", "vMetalnessMapUv"],
  ["normal_fragment_maps", "vNormalMapUv"],
  ["emissivemap_fragment", "vEmissiveMapUv"],
  ["aomap_fragment", "vAoMapUv"],
];

/**
 * Turn `mat` into a parallax material driven by `heightTex`. `scale` is in UV
 * units (0 disables). The material MUST have a base-color `map` set so
 * `vMapUv` exists — pass the white fallback if the asset has no albedo.
 */
export function applyParallax(mat: THREE.MeshStandardMaterial, heightTex: THREE.Texture, scale: number): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uHeightMap = { value: heightTex };
    shader.uniforms.uParallaxScale = { value: scale };

    // Inject the function just before main(), where every varying (vNormal,
    // vViewPosition, the vMapUv family) is already declared.
    let fs = shader.fragmentShader.replace("void main() {", `${PARALLAX_GLSL}\nvoid main() {`);

    // Compute the offset once, before the first map is sampled.
    fs = fs.replace(
      "#include <map_fragment>",
      "vec2 pomOffset = parallaxOffset( vMapUv );\n#include <map_fragment>",
    );

    // Expand each map chunk ourselves and add the offset to its UV. The
    // #include directives are still literal at onBeforeCompile time, so this
    // replaces them before three resolves them.
    for (const [chunk, uv] of MAP_CHUNKS) {
      const src = THREE.ShaderChunk[chunk as keyof typeof THREE.ShaderChunk];
      if (typeof src !== "string") continue;
      fs = fs.replace(`#include <${chunk}>`, src.split(uv).join(`(${uv} + pomOffset)`));
    }

    shader.fragmentShader = fs;
  };
  // Force a distinct program: without this, three's cache could hand a
  // parallax material the un-patched program of a plain one with equal defines.
  mat.customProgramCacheKey = () => "parallax-pom";
}
