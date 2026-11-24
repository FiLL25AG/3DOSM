// Tekstura nakładana na teren: obszary, miękkie cienie budynków i pomostów oraz wybór obszarów.
import * as THREE from "three";
import { pointInRing } from "../core/diagnostics.js";
import { SUN } from "./shaders.js";

// Nakładka obszarów na teren: 8192 px na dłuższy bok wycinka (ok. 0,55 m na piksel przy 4,5 km).
const MAX_SIZE = 8192, MASK_SIZE = 4096;
// Maska materiału terenu (kanały): R roślinność, G piasek lub odkryty grunt, B woda. Decyduje o fakturze w shaderze terenu.
const MASK_CHANNEL = { "land.grass": "#ff0000", "land.park": "#ff0000", "land.garden": "#ff0000", "land.flowerbed": "#ff0000", "land.heath": "#ff0000", "land.scrub": "#ff0000", "land.forest": "#ff0000", "land.wetland": "#ff0000", "land.sand": "#00ff00", "water.area": "#0000ff" };
const SHADOW_SCALE = 0.5;
const SHADOW_X = -SUN.x / SUN.z, SHADOW_Y = -SUN.y / SUN.z;

function ringsOf(feature) {
  if (feature.geometry === "multipolygon") return feature.polygons;
  const ring = [];
  for (let i = 0; i < feature.points.length; i += 3) ring.push(feature.points[i], feature.points[i + 1]);
  return [[ring]];
}

export class AreaOverlay {
  constructor(model, extent, polygon) {
    Object.assign(this, { model, extent, polygon });
    const [w, s, e, n] = extent;
    this.scale = MAX_SIZE / Math.max(e - w, n - s);
    this.canvas = document.createElement("canvas");
    this.canvas.width = Math.ceil((e - w) * this.scale);
    this.canvas.height = Math.ceil((n - s) * this.scale);
    this.context = this.canvas.getContext("2d");
    this.shadowCanvas = document.createElement("canvas");
    this.shadowCanvas.width = Math.ceil(this.canvas.width * SHADOW_SCALE);
    this.shadowCanvas.height = Math.ceil(this.canvas.height * SHADOW_SCALE);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.anisotropy = 8;
    this.texture.flipY = false;
    this.maskScale = MASK_SIZE / Math.max(e - w, n - s);
    this.maskCanvas = document.createElement("canvas");
    this.maskCanvas.width = Math.ceil((e - w) * this.maskScale);
    this.maskCanvas.height = Math.ceil((n - s) * this.maskScale);
    this.maskTexture = new THREE.CanvasTexture(this.maskCanvas);
    this.maskTexture.minFilter = THREE.LinearMipmapLinearFilter;
    this.maskTexture.flipY = false;
    this.hiddenGroups = new Set();
    this.items = [];
  }

  _trace(path, ring, scale = this.scale, dx = 0, dy = 0) {
    const [w, s] = this.extent;
    for (let i = 0; i < ring.length; i += 2) {
      const x = (ring[i] + dx - w) * scale, y = (ring[i + 1] + dy - s) * scale;
      if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
    path.closePath();
  }

  /** Cienie są liczone raz na zmianę danych i nie kosztują nic podczas rysowania klatki. */
  _drawShadows(c) {
    const shadow = this.shadowCanvas.getContext("2d");
    shadow.clearRect(0, 0, this.shadowCanvas.width, this.shadowCanvas.height);
    shadow.fillStyle = "#000"; shadow.strokeStyle = "#000"; shadow.lineCap = "round"; shadow.lineJoin = "round";
    const scale = this.scale * SHADOW_SCALE;
    const [w, s] = this.extent;
    for (const state of this.model.states.values()) {
      const { interp, feature, level } = state;
      if (this.hiddenGroups.has(interp.classDef.group)) continue;
      if (interp.classDef.render === "extrude" && interp.geometry === "area") {
        const height = interp.dimensions.height.value, path = new Path2D();
        for (const rings of ringsOf(feature)) {
          for (let k = 0; k <= 4; k += 1) this._trace(path, rings[0], scale, (SHADOW_X * height * k) / 4, (SHADOW_Y * height * k) / 4);
        }
        shadow.fill(path, "nonzero");
      } else if (level?.lifted && level.units > 0) {
        const { points } = feature;
        shadow.lineWidth = (interp.dimensions.width?.value ?? 4) * scale;
        shadow.beginPath();
        for (let i = 0; i < level.z.length; i += 1) {
          const rise = Math.max(0, level.z[i] - (points[i * 3 + 2] ?? level.z[i]));
          const x = (points[i * 3] + SHADOW_X * rise - w) * scale, y = (points[i * 3 + 1] + SHADOW_Y * rise - s) * scale;
          if (i === 0) shadow.moveTo(x, y); else shadow.lineTo(x, y);
        }
        shadow.stroke();
      }
    }
    c.save();
    c.globalCompositeOperation = "source-over";
    c.globalAlpha = 0.2;
    c.filter = "blur(3px)";
    c.imageSmoothingEnabled = true;
    c.drawImage(this.shadowCanvas, 0, 0, this.canvas.width, this.canvas.height);
    c.restore();
  }

  redraw() {
    const { context: c, canvas } = this;
    c.clearRect(0, 0, canvas.width, canvas.height);
    const mask = this.maskCanvas.getContext("2d");
    mask.fillStyle = "#000"; mask.fillRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
    this.items = [];
    const states = [...this.model.states.values()]
      .filter((s) => s.interp.classDef.render === "area" && s.interp.geometry === "area")
      .sort((a, b) => (a.interp.classDef.order ?? 0) - (b.interp.classDef.order ?? 0));
    for (const state of states) {
      const polygons = ringsOf(state.feature);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, area = 0;
      for (const rings of polygons) {
        const r = rings[0];
        for (let i = 0; i < r.length; i += 2) {
          minX = Math.min(minX, r[i]); maxX = Math.max(maxX, r[i]);
          minY = Math.min(minY, r[i + 1]); maxY = Math.max(maxY, r[i + 1]);
          const j = (i + 2) % r.length;
          area += r[i] * r[j + 1] - r[j] * r[i + 1];
        }
      }
      const def = state.interp.classDef;
      if (this.hiddenGroups.has(def.group)) continue;
      this.items.push({ id: state.feature.id, polygons, minX, minY, maxX, maxY, area: Math.abs(area) / 2 });
      const path = new Path2D();
      for (const rings of polygons) for (const ring of rings) this._trace(path, ring);
      c.fillStyle = state.interp.areaColour ?? def.color;
      c.globalAlpha = def.group === "landcover" ? 0.85 : 1;
      c.fill(path, "evenodd");
      // Maska: klasa bez kanału (np. teren zabudowany) czyści kanały, bo leży nad wcześniejszymi obszarami.
      const maskPath = new Path2D();
      for (const rings of polygons) for (const ring of rings) this._trace(maskPath, ring, this.maskScale);
      mask.fillStyle = MASK_CHANNEL[state.interp.classId] ?? "#000";
      mask.fill(maskPath, "evenodd");
      if (def.group === "water") {
        c.strokeStyle = "#d6ebf7"; c.lineWidth = 5; c.globalAlpha = 0.8;
        c.stroke(path);
      }
    }
    c.globalAlpha = 1;
    this._drawShadows(c);
    // Granica obszaru opracowania jest tylko linią: teren poza nią nie jest przesłaniany.
    const edge = new Path2D();
    this._trace(edge, this.polygon);
    c.strokeStyle = "rgba(95,110,125,0.55)"; c.lineWidth = 2.5; c.setLineDash([16, 12]);
    c.stroke(edge);
    c.setLineDash([]);
    this.texture.needsUpdate = true;
    this.maskTexture.needsUpdate = true;
  }

  pick(x, y) {
    let best = null;
    for (const item of this.items) {
      if (x < item.minX || x > item.maxX || y < item.minY || y > item.maxY || (best && item.area >= best.area)) continue;
      const inside = item.polygons.some((rings) => pointInRing(x, y, rings[0]) && !rings.slice(1).some((hole) => pointInRing(x, y, hole)));
      if (inside) best = item;
    }
    return best?.id ?? null;
  }
}
