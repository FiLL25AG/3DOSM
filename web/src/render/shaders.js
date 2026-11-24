// Materiały w miękkiej, stylizowanej oprawie: jedno światło, światło otoczenia i lekka mgła, bez postprocessingu.
// Kolory są w sRGB wprost, a tryb uPick zapisuje identyfikator obiektu do bufora wyboru.
import * as THREE from "three";

export const SUN = new THREE.Vector3(-0.5, -0.38, 0.78).normalize();
export const HAZE = new THREE.Color().setStyle("#e6edf0", THREE.LinearSRGBColorSpace);
const HIGHLIGHT = "vec3(0.10, 0.62, 0.72)";
// Przygaszenie bez przezroczystości: warstwa zachowuje kolejność rysowania i może leżeć pod nawierzchniami.
const FADED = "vec3(0.92, 0.92, 0.88)";

export const MAX_CUTS = 96;

export function sharedUniforms() {
  return {
    uCutA: { value: Array.from({ length: MAX_CUTS }, () => new THREE.Vector4()) }, uCutB: { value: Array.from({ length: MAX_CUTS }, () => new THREE.Vector4()) }, uCutCount: { value: 0 }, uTunnelMask: { value: null }, uTunnelExtent: { value: new THREE.Vector4(0, 0, 1, 1) },
    uExag: { value: 1 }, uZ0: { value: 80 }, uPick: { value: 0 }, uPxScale: { value: 1000 },
    uSelected: { value: new THREE.Vector3(-1, -1, -1) }, uSun: { value: SUN.clone() },
    uHaze: { value: HAZE.clone() }, uFogRange: { value: 12000 }, uDetail: { value: 1 },
  };
}

// Granica szczegółowości zależy od odległości fragmentu, więc połączone trasy znikają w tym samym miejscu.
const LOD_V = "attribute float aRange; varying float vRange;";
const LOD_F = `uniform float uDetail; varying float vRange;
  void lodDiscard(){
    if (vRange <= 0.0) return;
    float limit = vRange * uDetail;
    float t = (vDist - limit * 0.88) / (limit * 0.12);
    float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (t > noise) discard;
  }`;

// Wnętrze tunelu: teren i bryły w obrysie tuby są wycinane, aby wlot był otwarty. Odcinek: (ax, ay, bx, by) oraz (dół w A, dół w B, wysokość, półszerokość).
// Maska tuneli odrzuca tanio prawie wszystkie fragmenty; pętla po odcinkach liczy się tylko przy tunelach.
const CUT_F = `uniform vec4 uCutA[${MAX_CUTS}]; uniform vec4 uCutB[${MAX_CUTS}]; uniform float uCutCount; uniform sampler2D uTunnelMask; uniform vec4 uTunnelExtent;
  bool insideCut(vec3 p){
    if (texture2D(uTunnelMask, (p.xy - uTunnelExtent.xy) / uTunnelExtent.zw).r < 0.5) return false;
    for (int i = 0; i < ${MAX_CUTS}; i++) {
      if (float(i) >= uCutCount) break;
      vec4 a = uCutA[i], b = uCutB[i];
      vec2 d = a.zw - a.xy;
      float t = dot(p.xy - a.xy, d) / max(dot(d, d), 1e-6);
      if (t < 0.0 || t > 1.0 || distance(p.xy, a.xy + d * t) > b.w) continue;
      float base = mix(b.x, b.y, t);
      if (p.z > base && p.z < base + b.z) return true;
    }
    return false;
  }`;

const EXAG = "vec3 exag(vec3 p){ p.z = uZ0 + (p.z - uZ0) * uExag; return p; }";
const COMMON_V = `uniform float uExag, uZ0, uPxScale; uniform vec3 uSelected; varying float vDist; ${EXAG}`;
const SELECTED = "float selected(vec3 id){ return distance(id, uSelected) < 0.001 ? 1.0 : 0.0; }";
const OUTPUT = `
  uniform float uPick, uFogRange; uniform vec3 uHaze, uSun; varying float vDist;
  vec3 atmosphere(vec3 color){ float f = vDist / uFogRange; return mix(color, uHaze, (1.0 - exp(-f * f)) * 0.9); }
  void writeColor(vec3 color, float alpha, vec3 id){
    if (uPick > 0.5) { if (id.x < 0.0) discard; gl_FragColor = vec4(id, 1.0); }
    else gl_FragColor = vec4(atmosphere(color), alpha);
  }`;

export function ribbonMaterial(shared, options = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uAlpha: { value: options.alpha ?? 1 } },
    vertexShader: `${COMMON_V} ${SELECTED} ${LOD_V}
      attribute vec2 aMiter; attribute float aSide, aHalf, aMinPx; attribute vec3 aColor, aPick;
      varying vec3 vColor, vPick; varying float vSel, vSide;
      void main(){
        vec3 p = exag(position);
        vec3 view = (viewMatrix * vec4(p, 1.0)).xyz;
        float dist = max(1.0, -view.z);
        vSel = selected(aPick); vSide = aSide; vDist = length(view); vRange = aRange;
        float half_ = max(aHalf, aMinPx * 0.5 * dist / uPxScale) + vSel * 1.5 * dist / uPxScale;
        p.xy += aMiter * half_;
        vColor = aColor; vPick = aPick;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `${OUTPUT} ${LOD_F} uniform float uAlpha; varying vec3 vColor, vPick; varying float vSel, vSide;
      void main(){
        lodDiscard();
        // Bez cieniowania krawędzi: zachodzące na siebie wstęgi mają tworzyć jednolitą nawierzchnię.
        writeColor(mix(mix(${FADED}, vColor, uAlpha), ${HIGHLIGHT}, vSel), 1.0, vPick);
      }`,
    depthTest: options.depthTest ?? true, depthWrite: options.depthWrite ?? true, side: THREE.DoubleSide,
    ...depthBias(options.bias),
  });
}

// Kolejność współpłaszczyznowych warstw ustala bufor głębi, bez przesuwania geometrii w pionie.
// Przesunięcie do kamery jest stałe: składnik zależny od nachylenia wypychałby warstwę przez ściany w widoku skośnym.
function depthBias(bias) {
  if (!bias) return {};
  return bias < 0 ? { polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: bias * 8 } : { polygonOffset: true, polygonOffsetFactor: bias, polygonOffsetUnits: bias * 2 };
}

// Odsuwa od kamery tylko zapisaną głębię; położenie na ekranie pozostaje bez zmian.
const PUSH_DEPTH = `vec4 pushedDepth(vec4 view, float meters){
    vec4 clip = projectionMatrix * view, back = view;
    back.z -= meters;
    vec4 far_ = projectionMatrix * back;
    clip.z = far_.z / far_.w * clip.w;
    return clip;
  }`;

export function solidMaterial(shared, options = {}) {
  return new THREE.ShaderMaterial({
    depthWrite: options.depthWrite ?? true,
    ...depthBias(options.bias),
    uniforms: { ...shared, uDepthPush: { value: options.depthPush ?? 0 }, uCut: { value: options.cut === false ? 0 : 1 } },
    vertexShader: `${COMMON_V} ${SELECTED} ${LOD_V} ${PUSH_DEPTH} uniform float uDepthPush;
      attribute vec3 aColor, aPick; attribute float aAo; varying vec3 vColor, vPick, vNormal, vWorld; varying float vSel, vAo;
      void main(){ vColor = aColor; vPick = aPick; vNormal = normal; vSel = selected(aPick); vAo = aAo; vRange = aRange; vWorld = position;
        vec4 view = viewMatrix * vec4(exag(position), 1.0); vDist = length(view.xyz);
        gl_Position = pushedDepth(view, uDepthPush); }`,
    fragmentShader: `${OUTPUT} ${LOD_F} ${CUT_F} uniform float uCut; varying vec3 vColor, vPick, vNormal, vWorld; varying float vSel, vAo;
      void main(){
        lodDiscard();
        if (uCut > 0.5 && uCutCount > 0.5 && insideCut(vWorld)) discard;
        vec3 n = normalize(vNormal);
        float wrap = dot(n, uSun) * 0.5 + 0.5;
        float sky = n.z * 0.5 + 0.5;
        vec3 light = mix(vec3(0.70, 0.73, 0.80), vec3(1.05, 1.02, 0.97), wrap * wrap) + sky * 0.06;
        vec3 color = vColor * light * mix(0.80, 1.0, smoothstep(0.0, 0.75, vAo));
        writeColor(mix(color, ${HIGHLIGHT}, vSel * 0.65), 1.0, vPick);
      }`,
    side: THREE.DoubleSide,
  });
}

/** Stopnie schodów: proceduralna faktura materiału leży w tym materiale, a linia trasy jest osobną wstęgą nad nim. */
export const STAIR_PATTERNS = ["speckle", "pavers", "planks", "tread", "blocks", "hatch", "solid"];

// Gładki szum wartości w układzie świata i jego suma oktaw z wygaszaniem: oktawa znika, zanim jej oczko zmaleje do
// rozmiaru piksela, więc faktura nie migocze z daleka. px to rozmiar piksela w jednostkach p (fwidth).
const NOISE_GLSL = `
      float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float vnoise(vec2 p){
        vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      float fbmAA(vec2 p, float px){
        float sum = 0.0, amp = 0.5, norm = 0.0, f = 1.0;
        for (int i = 0; i < 4; i++) {
          sum += amp * (1.0 - smoothstep(0.3, 0.65, px * f)) * (vnoise(p * f + float(i) * 17.3) - 0.5);
          norm += amp; f *= 2.0; amp *= 0.5;
        }
        return sum / norm;
      }`;

// Faktury są generowane w shaderze: nie wymagają plików tekstur i są wspólne dla jezdni, ścieżek i schodów.
const PATTERN_GLSL = NOISE_GLSL + `
      float line(float value, float period, float width){
        float d = abs(fract(value / period + 0.5) - 0.5) * period;
        float aa = max(fwidth(value), 1e-4);
        return 1.0 - smoothstep(width, width + aa * 1.5, d);
      }
      float noise(vec2 p){ return fract(sin(dot(floor(p), vec2(12.9898, 78.233))) * 43758.5453); }
      float pattern(vec2 uv, float kind){
        if (kind < 0.5) {
          // Asfalt i podobne: ziarno kruszywa (ok. 3 cm), pojedyncze jasne kamyki i rozległe plamy zużycia.
          float px = fwidth(uv.x) + fwidth(uv.y);
          float grain = fbmAA(uv / 0.08, px / 0.08), micro = fbmAA(uv / 0.025, px / 0.025), wear = fbmAA(uv / 3.0, px / 3.0);
          float stones = smoothstep(0.7, 0.86, vnoise(uv / 0.014)) * (1.0 - smoothstep(0.004, 0.012, px));
          return clamp(0.3 + grain * 2.4 + micro * 1.2 + wear * 1.1 - stones * 0.35, 0.0, 1.0);
        }
        if (kind < 1.5) { float row = floor(uv.y / 0.2); return max(line(uv.y, 0.2, 0.012), line(uv.x + mod(row, 2.0) * 0.1, 0.2, 0.012)); }
        if (kind < 2.5) return max(line(uv.y, 0.14, 0.008), step(0.9, noise(vec2(uv.x * 3.0, uv.y * 60.0))) * 0.35);
        if (kind < 3.5) return max(line(uv.x + uv.y, 0.12, 0.012), line(uv.x - uv.y, 0.12, 0.012));
        if (kind < 4.5) { float row = floor(uv.y / 0.42); return max(line(uv.y, 0.42, 0.016), line(uv.x + mod(row, 2.0) * 0.24, 0.48, 0.016)); }
        if (kind < 5.5) return line(uv.x + uv.y, 0.32, 0.01) * 0.6;
        return 0.0;
      }
      float patternDetail(vec2 uv){ return 1.0 - smoothstep(0.02, 0.09, fwidth(uv.x) + fwidth(uv.y)); }`;

/** Nawierzchnia wstęgi: kolor i faktura materiału, bez koloru klasy i bez linii przebiegu. */
export function surfaceRibbonMaterial(shared, options = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uAlpha: { value: options.alpha ?? 1 } },
    vertexShader: `${COMMON_V} ${SELECTED} ${LOD_V}
      attribute vec2 aMiter, aUv; attribute float aSide, aHalf, aMinPx, aPattern; attribute vec3 aColor, aAccent, aPick;
      varying vec3 vColor, vAccent, vPick; varying vec2 vUv; varying float vSel, vPattern;
      void main(){
        vec3 p = exag(position);
        vec3 view = (viewMatrix * vec4(p, 1.0)).xyz;
        float dist = max(1.0, -view.z);
        vSel = selected(aPick); vDist = length(view); vRange = aRange; vUv = aUv; vPattern = aPattern;
        float half_ = max(aHalf, aMinPx * 0.5 * dist / uPxScale) + vSel * 1.5 * dist / uPxScale;
        p.xy += aMiter * half_;
        vColor = aColor; vAccent = aAccent; vPick = aPick;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `${OUTPUT} ${LOD_F} ${PATTERN_GLSL} uniform float uAlpha; varying vec3 vColor, vAccent, vPick; varying vec2 vUv; varying float vSel, vPattern;
      void main(){
        lodDiscard();
        // Faktura asfaltu (wzór 0) sama wygasza drobne skale; plamy zużycia mają być widoczne także z daleka.
        vec3 color = mix(vColor, vAccent, pattern(vUv, vPattern) * (vPattern < 0.5 ? 1.0 : patternDetail(vUv)));
        // Zaznaczenie tylko barwi nawierzchnię, aby materiał był widoczny podczas edycji tagów.
        writeColor(mix(mix(${FADED}, color, uAlpha), ${HIGHLIGHT}, vSel * 0.28), 1.0, vPick);
      }`,
    depthTest: options.depthTest ?? true, depthWrite: options.depthWrite ?? true, side: THREE.DoubleSide,
    ...depthBias(options.bias),
  });
}

export const BARRIER_PATTERNS = ["solid", "masonry", "planks", "mesh", "railing", "hedge", "guard", "handrail", "boom", "panel"];

/** Bariery: wzór oddaje rodzaj ogrodzenia, a ażurowe typy naprawdę przepuszczają widok. */
export function barrierMaterial(shared) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared },
    vertexShader: `${COMMON_V} ${SELECTED} ${LOD_V}
      attribute vec3 aColor, aAccent, aPick; attribute vec2 aUv; attribute float aAo, aPattern, aSpan;
      varying vec3 vColor, vAccent, vPick, vNormal; varying vec2 vUv; varying float vSel, vAo, vPattern, vSpan;
      void main(){ vColor = aColor; vAccent = aAccent; vPick = aPick; vNormal = normal; vUv = aUv; vAo = aAo; vPattern = aPattern; vSpan = aSpan; vSel = selected(aPick); vRange = aRange;
        vec4 view = viewMatrix * vec4(exag(position), 1.0); vDist = length(view.xyz);
        gl_Position = projectionMatrix * view; }`,
    fragmentShader: `${OUTPUT} ${LOD_F} ${PATTERN_GLSL} varying vec3 vColor, vAccent, vPick, vNormal; varying vec2 vUv; varying float vSel, vAo, vPattern, vSpan;
      void main(){
        lodDiscard();
        float u = vUv.x, v = vUv.y, cover = 1.0, mark = 0.0, frame = max(step(vSpan - 0.05, v), line(u, 2.5, 0.03));
        if (vPattern < 0.5) mark = 0.0;
        else if (vPattern < 1.5) mark = max(line(v, 0.2, 0.012), line(u + mod(floor(v / 0.2), 2.0) * 0.2, 0.4, 0.012));
        else if (vPattern < 2.5) mark = line(u, 0.16, 0.012);
        else if (vPattern < 3.5) { cover = max(frame, max(line(u + v, 0.14, 0.012), line(u - v, 0.14, 0.012))); mark = frame; }
        else if (vPattern < 4.5) { cover = max(max(frame, step(v, 0.08)), line(u, 0.14, 0.014)); mark = frame; }
        else if (vPattern < 5.5) mark = step(0.55, noise(vec2(u, v) * 9.0)) * 0.8;
        else if (vPattern < 6.5) { cover = max(step(vSpan * 0.55, v), line(u, 2.0, 0.05)); mark = line(v, vSpan * 0.3, 0.02) * step(vSpan * 0.55, v); }
        else if (vPattern < 7.5) { cover = max(max(step(vSpan - 0.06, v), line(v, vSpan * 0.5, 0.02)), line(u, 1.5, 0.025)); mark = line(u, 1.5, 0.025); }
        else if (vPattern < 8.5) mark = step(0.5, fract(u));
        else mark = line(u, 4.0, 0.03);
        float detail = patternDetail(vUv);
        // Daleko ażur staje się rzadkim rastrem: bariera pozostaje widoczna, ale nie migocze.
        if (cover < 0.5) { if (detail > 0.5) discard; if (fract(52.98 * fract(dot(gl_FragCoord.xy, vec2(0.0671, 0.0058)))) > 0.45) discard; }
        vec3 n = normalize(vNormal);
        float wrap = dot(n, uSun) * 0.5 + 0.5;
        vec3 light = mix(vec3(0.70, 0.73, 0.80), vec3(1.05, 1.02, 0.97), wrap * wrap);
        vec3 color = mix(vColor, vAccent, mark * (vPattern > 7.5 && vPattern < 8.5 ? 1.0 : detail)) * light * mix(0.8, 1.0, vAo);
        writeColor(mix(color, ${HIGHLIGHT}, vSel * 0.6), 1.0, vPick);
      }`,
    side: THREE.DoubleSide,
  });
}

export function stairMaterial(shared) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared },
    vertexShader: `${COMMON_V} ${SELECTED} ${LOD_V}
      attribute vec3 aColor, aAccent, aPick; attribute vec2 aUv; attribute float aAo, aPattern;
      varying vec3 vColor, vAccent, vPick, vNormal; varying vec2 vUv; varying float vSel, vAo, vPattern;
      void main(){ vColor = aColor; vAccent = aAccent; vPick = aPick; vNormal = normal; vUv = aUv; vAo = aAo; vPattern = aPattern; vSel = selected(aPick); vRange = aRange;
        vec4 view = viewMatrix * vec4(exag(position), 1.0); vDist = length(view.xyz);
        gl_Position = projectionMatrix * view; }`,
    fragmentShader: `${OUTPUT} ${LOD_F} ${PATTERN_GLSL} varying vec3 vColor, vAccent, vPick, vNormal; varying vec2 vUv; varying float vSel, vAo, vPattern;
      void main(){
        lodDiscard();
        vec3 n = normalize(vNormal);
        float wrap = dot(n, uSun) * 0.5 + 0.5;
        vec3 light = mix(vec3(0.68, 0.71, 0.78), vec3(1.05, 1.02, 0.97), wrap * wrap);
        // Daleko faktura przechodzi w kolor bazowy, aby nie tworzyć migotania.
        vec3 color = mix(vColor, vAccent, pattern(vUv, vPattern) * patternDetail(vUv)) * light * mix(0.78, 1.0, vAo);
        writeColor(mix(color, ${HIGHLIGHT}, vSel * 0.6), 1.0, vPick);
      }`,
    side: THREE.DoubleSide,
  });
}

/**
 * Roślinność jako instancje jednej siatki wzorcowej. Wzorzec ma część pnia (aPart = 0: walec jednostkowy z = 0…1)
 * i korony (aPart = 1: kula jednostkowa albo stożek z = 0…1). Instancja: podstawa (aBase), wymiary (aDims: wysokość,
 * promień korony, promień pnia, spód korony), obrót (aYaw), kolor korony i identyfikator wyboru.
 * Pas szczegółowości (uBand, w metrach od kamery do podstawy drzewa, skalowany uDetail) wybiera wzorzec dla każdego
 * drzewa osobno, więc wzorce bliski i daleki stykają się bez nakładania.
 */
export function vegetationMaterial(shared, { cone, band, trunkColour }) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uBand: { value: new THREE.Vector2(...band) }, uTrunk: { value: new THREE.Color().setStyle(trunkColour, THREE.LinearSRGBColorSpace) } },
    defines: cone ? { CONE: 1 } : {},
    vertexShader: `${COMMON_V} ${SELECTED} uniform float uDetail; uniform vec2 uBand; uniform vec3 uTrunk;
      attribute float aPart, aYaw; attribute vec3 aBase, aColor, aPick; attribute vec4 aDims;
      varying vec3 vColor, vPick, vNormal; varying float vSel, vAo;
      void main(){
        vec3 base = exag(aBase);
        float reach = distance(base, cameraPosition);
        vSel = selected(aPick);
        if ((reach < uBand.x * uDetail || reach >= uBand.y * uDetail) && vSel < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        float height = aDims.x, crownR = aDims.y, trunkR = aDims.z, crownBase = aDims.w, c = cos(aYaw), s = sin(aYaw);
        vec3 p, n;
        if (aPart < 0.5) {
          p = vec3(position.xy * trunkR, position.z * (crownBase + 0.3 * (height - crownBase)));
          n = normal; vColor = uTrunk; vAo = 0.8;
        } else {
          float crownH = height - crownBase;
#ifdef CONE
          p = vec3(position.xy * crownR, crownBase + position.z * crownH);
          n = normalize(vec3(normal.xy / max(crownR, 0.01), normal.z / max(crownH, 0.01)));
          vAo = mix(0.72, 1.0, position.z);
#else
          p = vec3(position.xy * crownR, crownBase + (position.z * 0.5 + 0.5) * crownH);
          n = normalize(vec3(normal.xy / max(crownR, 0.01), normal.z / max(crownH * 0.5, 0.01)));
          vAo = mix(0.72, 1.0, position.z * 0.5 + 0.5);
#endif
          vColor = aColor;
        }
        p.xy = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
        n.xy = vec2(c * n.x - s * n.y, s * n.x + c * n.y);
        vNormal = n; vPick = aPick;
        vec4 view = viewMatrix * vec4(base + p, 1.0); vDist = length(view.xyz);
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: `${OUTPUT} varying vec3 vColor, vPick, vNormal; varying float vSel, vAo;
      void main(){
        vec3 n = normalize(vNormal);
        float wrap = dot(n, uSun) * 0.5 + 0.5;
        vec3 light = mix(vec3(0.66, 0.70, 0.78), vec3(1.05, 1.02, 0.95), wrap * wrap) + (n.z * 0.5 + 0.5) * 0.06;
        writeColor(mix(vColor * light * vAo, ${HIGHLIGHT}, vSel * 0.65), 1.0, vPick);
      }`,
    side: THREE.FrontSide,
  });
}

/** Przewody linii energetycznych: odcinki o szerokości piksela (przewód ma kilka centymetrów), z mgłą i wyborem. */
export function wireMaterial(shared, colourHex) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uColour: { value: new THREE.Color().setStyle(colourHex, THREE.LinearSRGBColorSpace) } },
    vertexShader: `${COMMON_V} ${SELECTED} ${LOD_V}
      attribute vec3 aPick; varying vec3 vPick; varying float vSel;
      void main(){ vPick = aPick; vSel = selected(aPick); vRange = aRange;
        vec4 view = viewMatrix * vec4(exag(position), 1.0); vDist = length(view.xyz);
        gl_Position = projectionMatrix * view; }`,
    fragmentShader: `${OUTPUT} ${LOD_F} uniform vec3 uColour; varying vec3 vPick; varying float vSel;
      void main(){ lodDiscard(); writeColor(mix(uColour, ${HIGHLIGHT}, vSel * 0.8), 1.0, vPick); }`,
  });
}

export function pointMaterial(shared, options = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared },
    vertexShader: `${COMMON_V} ${SELECTED} uniform float uDetail;
      attribute vec3 aColor, aPick; attribute float aSize, aShape, aRange; varying vec3 vColor, vPick; varying float vSel, vShape;
      void main(){ vColor = aColor; vPick = aPick; vSel = selected(aPick); vShape = aShape;
        gl_PointSize = aSize + vSel * 5.0;
        vec4 view = viewMatrix * vec4(exag(position), 1.0); vDist = options_dist(view);
        gl_Position = projectionMatrix * view;
        if (aRange > 0.0 && -view.z > aRange * uDetail && vSel < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }`
      .replace("options_dist(view)", options.depthTest === false ? "0.0" : "-view.z"),
    fragmentShader: `${OUTPUT} varying vec3 vColor, vPick; varying float vSel, vShape;
      void main(){
        vec2 p = gl_PointCoord * 2.0 - 1.0; float d; float shape = floor(vShape + 0.01); float hollow = fract(vShape) > 0.2 ? 1.0 : 0.0;
        if (shape < 0.5) d = length(p);
        else if (shape < 1.5) d = abs(p.x) + abs(p.y);
        else if (shape < 2.5) d = max(abs(p.x), abs(p.y));
        else d = max(abs(p.x) * 1.5 + p.y * 0.75, -p.y);
        if (d > 1.0) discard;
        vec3 color = d > 0.70 ? vec3(0.98, 0.98, 0.97) : vColor;
        if (hollow > 0.5 && d < 0.36) color = vec3(0.98, 0.98, 0.97);
        writeColor(mix(color, ${HIGHLIGHT}, vSel * 0.6), 1.0, vPick);
      }`,
    depthTest: options.depthTest ?? true, depthWrite: options.depthTest ?? true, transparent: false,
  });
}

export function terrainMaterial(shared, overlay, extent, zRange, conform, mask) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared, uOverlay: { value: overlay }, uExtent: { value: new THREE.Vector4(extent[0], extent[1], extent[2] - extent[0], extent[3] - extent[1]) },
      uRange: { value: new THREE.Vector2(zRange[0], zRange[1]) }, uRelief: { value: 1 }, uConform: { value: conform }, uMask: { value: mask },
      uWallIndex: { value: null }, uWallData: { value: null }, uWallCount: { value: 0 },
    },
    // Teren jest wyprofilowany pod trasy, więc może przesłaniać obiekty dokładnie; mały zapas rośnie z odległością razem z siatką kafli.
    vertexShader: `${COMMON_V} uniform sampler2D uConform, uTunnelMask; uniform vec4 uTunnelExtent; attribute float aFlag, aCell; varying vec3 vNormal; varying vec2 vXY; varying float vZ, vFlag, vFloor;
      void main(){ vec2 xy = position.xy; vXY = xy; vFlag = aFlag;
        // Posadzka przy ścianie oporowej (aCell < 0) ma własną wysokość: bez dopasowania, które ją podnosiłoby przy licu.
        vFloor = aCell < 0.0 ? 1.0 : 0.0;
        float cell = abs(aCell);
        // Dopasowanie i maska tuneli mają własną siatkę (stały bok teksela), inną niż nakładka obszarów.
        vec2 fit = texture2D(uConform, (xy - uTunnelExtent.xy) / uTunnelExtent.zw).rg;
        float weight = aCell < 0.0 ? 0.0 : clamp(fit.g, 0.0, 1.0), ground = position.z;
        if (weight > 0.001) ground = mix(ground, 85.0 + fit.r / fit.g, weight);
        vZ = ground;
        vNormal = normalize(vec3(normal.xy * uExag * (1.0 - weight), normal.z));
        vec3 p = exag(vec3(xy, ground));
        vec4 view = viewMatrix * vec4(p, 1.0); vDist = -view.z;
        vec4 clip = projectionMatrix * view;
        // Nad tunelem zapas jest mały: strop leży co najmniej 0,6 m pod terenem i nie może przez niego prześwitywać.
        float tunnel = texture2D(uTunnelMask, (xy - uTunnelExtent.xy) / uTunnelExtent.zw).r;
        vec4 lowered = viewMatrix * vec4(p.xy, p.z - mix(1.0 + cell * 1.5 + vDist * 0.005, 0.15 + cell * 0.15 + vDist * 0.001, tunnel) * uExag, 1.0);
        lowered.z -= mix(1.0 + cell * 1.5 + vDist * 0.003, 0.1 + cell * 0.1 + vDist * 0.001, tunnel) * uExag;
        vec4 depth = projectionMatrix * lowered;
        clip.z = depth.z / depth.w * clip.w;
        gl_Position = clip; }`,
    fragmentShader: `${OUTPUT} ${CUT_F} ${NOISE_GLSL} uniform sampler2D uOverlay, uMask; uniform vec4 uExtent; uniform vec2 uRange; uniform float uRelief;
      varying vec3 vNormal; varying vec2 vXY; varying float vZ, vFlag, vFloor;
      // Teren po niższej stronie ściany oporowej, w pasie posadzki, jest odrzucany: siatka terenu (1–4 m) i NMT nie mają ostrego
      // uskoku, więc trójkąty przecinające ścianę wychodziłyby przed lico. Odcinek: z tekstury indeksu (siatka dopasowania).
      uniform sampler2D uWallIndex, uWallData; uniform float uWallCount;
      bool wallCut(vec2 p){
        if (uWallCount < 0.5) return false;
        float id = texture2D(uWallIndex, (p - uTunnelExtent.xy) / uTunnelExtent.zw).r;
        if (id < 0.5) return false;
        int c = int(id + 0.5) - 1;
        float wall = texelFetch(uWallData, ivec2(c, 1), 0).x;
        for (int k = -1; k <= 1; k++) {
          int i = c + k;
          if (i < 0 || float(i) >= uWallCount) continue;
          vec4 a = texelFetch(uWallData, ivec2(i, 0), 0), b = texelFetch(uWallData, ivec2(i, 1), 0);
          if (b.x != wall) continue;
          vec2 ab = a.zw - a.xy;
          float l2 = max(dot(ab, ab), 1e-4), t = dot(p - a.xy, ab) / l2;
          if (t < 0.0 || t > 1.0) continue;
          float side = (ab.x * (p.y - a.y) - ab.y * (p.x - a.x)) / sqrt(l2) * b.y;
          if (side > -0.05 && side < b.z) return true;
        }
        return false;
      }
      vec3 hypso(float t){
        vec3 low = vec3(0.90, 0.93, 0.85), mid = vec3(0.95, 0.94, 0.87), high = vec3(0.94, 0.90, 0.83);
        return t < 0.5 ? mix(low, mid, t * 2.0) : mix(mid, high, t * 2.0 - 1.0);
      }
      void main(){
        if (uCutCount > 0.5 && insideCut(vec3(vXY, vZ))) discard;
        if (vFloor < 0.5 && wallCut(vXY)) discard;
        float t = clamp((vZ - uRange.x) / (uRange.y - uRange.x), 0.0, 1.0);
        vec3 base = mix(vec3(0.94, 0.93, 0.90), hypso(t), uRelief);
        vec4 over = texture2D(uOverlay, (vXY - uExtent.xy) / uExtent.zw);
        vec3 color = mix(base, over.rgb, over.a);
        // Faktura terenu liczona w metrach: trawa (zielony obszar nakładki) ma kępy, źdźbła i suchsze plamy, pozostały teren
        // delikatne nierówności; woda zostaje gładka. Drobne skale znikają z odległością, zanim zaczęłyby migotać.
        float px = fwidth(vXY.x) + fwidth(vXY.y);
        vec3 kind = texture2D(uMask, (vXY - uExtent.xy) / uExtent.zw).rgb;
        float grass = kind.r, water = kind.b;
        float clumps = fbmAA(vXY / 5.0, px / 5.0), blades = fbmAA(vXY / 0.4, px / 0.4), soil = fbmAA(vXY / 3.0, px / 3.0);
        color *= 1.0 + grass * (clumps * 0.26 + blades * 0.22) + (1.0 - grass) * (1.0 - water) * soil * 0.08;
        color = mix(color, color * vec3(1.05, 1.02, 0.86), grass * smoothstep(0.05, 0.25, clumps) * 0.6);
        float wrap = dot(normalize(vNormal), uSun) * 0.5 + 0.5;
        float flat_ = uSun.z * 0.5 + 0.5;
        color *= mix(1.0, clamp(1.0 + (wrap - flat_) * 1.5, 0.80, 1.10), uRelief);
        if (vFlag > 0.5 && mod(floor(vXY.x / 3.0) + floor(vXY.y / 3.0), 2.0) < 0.5) color = mix(color, vec3(0.92, 0.66, 0.40), 0.45);
        writeColor(color, 1.0, vec3(0.0));
      }`,
  });
}

export function skyMaterial(shared) {
  return new THREE.ShaderMaterial({
    uniforms: { uPick: shared.uPick, uFogRange: shared.uFogRange, uHaze: shared.uHaze, uSun: shared.uSun, uSpace: { value: 0 } },
    vertexShader: `varying vec3 vRay; varying float vDist;
      void main(){ vDist = 0.0; vec4 far = inverse(projectionMatrix * viewMatrix) * vec4(position.xy, 1.0, 1.0);
        vRay = far.xyz / far.w - cameraPosition; gl_Position = vec4(position.xy, 1.0, 1.0); }`,
    fragmentShader: `${OUTPUT} uniform float uSpace; varying vec3 vRay;
      void main(){
        vec3 ray = normalize(vRay);
        vec3 sky = mix(uHaze, vec3(0.66, 0.81, 0.91), smoothstep(0.0, 0.42, ray.z));
        sky += vec3(0.10, 0.08, 0.05) * pow(max(dot(ray, uSun), 0.0), 18.0);
        writeColor(mix(sky, vec3(0.055, 0.075, 0.115), uSpace), 1.0, vec3(-1.0));
      }`,
    depthTest: false, depthWrite: false,
  });
}

export function globeMaterial(shared, land, toEcef, marker) {
  return new THREE.ShaderMaterial({
    uniforms: { uPick: shared.uPick, uFogRange: shared.uFogRange, uHaze: shared.uHaze, uSun: shared.uSun, uLand: { value: land }, uToEcef: { value: toEcef }, uMarker: { value: marker }, uMarkerOn: { value: 0 }, uNear: { value: 1 } },
    vertexShader: `varying vec3 vDir; varying float vDist;
      void main(){ vDir = normalize(position); vec4 view = modelViewMatrix * vec4(position, 1.0); vDist = -view.z; gl_Position = projectionMatrix * view; }`,
    fragmentShader: `${OUTPUT} uniform sampler2D uLand; uniform mat3 uToEcef; uniform vec3 uMarker; uniform float uMarkerOn, uNear; varying vec3 vDir;
      void main(){
        vec3 e = normalize(uToEcef * normalize(vDir));
        float lat = asin(clamp(e.z, -1.0, 1.0)), lon = atan(e.y, e.x);
        float land = texture2D(uLand, vec2(lon / 6.2831853 + 0.5, lat / 3.1415927 + 0.5)).r;
        vec3 color = mix(vec3(0.56, 0.74, 0.86), vec3(0.83, 0.88, 0.76), land);
        vec2 g = abs(fract(vec2(lon, lat) / 0.261799 + 0.5) - 0.5) / fwidth(vec2(lon, lat) / 0.261799);
        color = mix(color, vec3(0.96), (1.0 - clamp(min(g.x, g.y), 0.0, 1.0)) * 0.22 * (1.0 - uNear));
        color = mix(color, vec3(0.92, 0.92, 0.87), uNear);
        float mark = distance(e, uMarker);
        if (uMarkerOn > 0.5 && mark < 0.012) color = mark > 0.007 ? vec3(0.99) : ${HIGHLIGHT};
        writeColor(color, 1.0, vec3(0.0));
      }`,
  });
}
