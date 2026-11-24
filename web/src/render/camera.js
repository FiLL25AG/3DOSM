// Kamera: orbita lokalna (Z w górę, Y na północ siatki) płynnie przechodząca w widok globusa.
import * as THREE from "three";

export const EARTH_RADIUS = 6371000;
// Wierzch kuli leży tuż pod terenem sceny, aby brzeg danych nie odstawał od tła.
export const GLOBE_CENTER = new THREE.Vector3(0, 0, -EARTH_RADIUS + 70);
const MAX_TILT = THREE.MathUtils.degToRad(82);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class CameraRig {
  constructor(camera, element, onChange, onClick) {
    Object.assign(this, { camera, element, onChange, onClick });
    this.target = new THREE.Vector3(0, 0, 90);
    this.distance = 9000;
    this.azimuth = 0;
    this.tilt = THREE.MathUtils.degToRad(35);
    this.northLock = false;
    this.globeLon = 0;
    this.globeLat = 0;
    this.heightAt = () => null;
    this.flight = null;
    this._bind();
  }

  get globeBlend() { return smooth(150000, 1200000, this.distance); }

  apply() {
    const { camera, target, distance, azimuth, tilt } = this;
    const fx = Math.sin(azimuth), fy = Math.cos(azimuth), st = Math.sin(tilt), ct = Math.cos(tilt);
    const eye = new THREE.Vector3(target.x - fx * st * distance, target.y - fy * st * distance, target.z + ct * distance);
    const up = new THREE.Vector3(fx * ct, fy * ct, st);
    const look = target.clone();
    const blend = this.globeBlend;
    if (blend > 0) {
      const cb = Math.cos(this.globeLat);
      const direction = new THREE.Vector3(Math.sin(this.globeLon) * cb, Math.sin(this.globeLat), Math.cos(this.globeLon) * cb);
      eye.lerp(GLOBE_CENTER.clone().addScaledVector(direction, EARTH_RADIUS + distance), blend);
      look.lerp(GLOBE_CENTER, blend);
      up.lerp(new THREE.Vector3(0, 1, 0), blend).normalize();
    }
    camera.position.copy(eye);
    camera.up.copy(up);
    camera.lookAt(look);
    camera.near = Math.max(0.5, distance * 0.01);
    camera.far = blend > 0 ? distance * 3 + EARTH_RADIUS * 3 : Math.max(40000, distance * 40);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  worldPerPixel() {
    return (2 * this.distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / this.element.clientHeight;
  }

  flyTo({ x, y, z, distance, tilt, azimuth }, duration = 900) {
    this.flight = {
      start: performance.now(), duration,
      from: { x: this.target.x, y: this.target.y, z: this.target.z, d: Math.log(this.distance), tilt: this.tilt, az: this.azimuth, lon: this.globeLon, lat: this.globeLat },
      to: { x: x ?? this.target.x, y: y ?? this.target.y, z: z ?? this.target.z, d: Math.log(distance ?? this.distance), tilt: tilt ?? this.tilt, az: this.northLock ? this.azimuth : azimuth ?? this.azimuth },
    };
    this.onChange();
  }

  update(now) {
    if (!this.flight) return false;
    const { start, duration, from, to } = this.flight;
    const raw = Math.min(1, (now - start) / duration);
    const t = raw * raw * (3 - 2 * raw);
    this.target.set(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, from.z + (to.z - from.z) * t);
    this.distance = Math.exp(from.d + (to.d - from.d) * t);
    this.tilt = from.tilt + (to.tilt - from.tilt) * t;
    let delta = (to.az - from.az) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    this.azimuth = from.az + delta * t;
    this.globeLon = from.lon * (1 - t);
    this.globeLat = from.lat * (1 - t);
    if (raw >= 1) this.flight = null;
    return true;
  }

  northUp() { this.flyTo({ azimuth: 0 }, 450); if (this.northLock && this.flight) this.flight.to.az = 0; }
  topDown() { this.flyTo({ tilt: 0 }, 450); }

  _groundPoint(clientX, clientY) {
    const box = this.element.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - box.left) / box.width) * 2 - 1, -((clientY - box.top) / box.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const { origin, direction } = ray.ray;
    if (direction.z >= -1e-3) return null;
    let z = this.target.z, point = null;
    for (let i = 0; i < 4; i += 1) {
      point = origin.clone().addScaledVector(direction, (z - origin.z) / direction.z);
      z = this.heightAt(point.x, point.y) ?? z;
    }
    return point;
  }

  groundPoint(clientX, clientY) { return this._groundPoint(clientX, clientY); }

  _bind() {
    const el = this.element;
    let drag = null;
    el.addEventListener("contextmenu", (event) => event.preventDefault());
    el.addEventListener("pointerdown", (event) => {
      drag = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, rotate: event.button === 2 || event.shiftKey, moved: false };
      el.setPointerCapture(event.pointerId);
      this.flight = null;
    });
    el.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      drag.x = event.clientX; drag.y = event.clientY;
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) drag.moved = true;
      if (!drag.moved) return;
      if (this.globeBlend > 0.5) {
        const rate = this.distance / (EARTH_RADIUS * 1.2 * el.clientHeight) + 0.0006;
        this.globeLon -= dx * rate;
        this.globeLat = THREE.MathUtils.clamp(this.globeLat + dy * rate, -1.4, 1.4);
      } else if (drag.rotate) {
        if (!this.northLock) this.azimuth -= dx * 0.005;
        this.tilt = THREE.MathUtils.clamp(this.tilt - dy * 0.004, 0, MAX_TILT);
      } else {
        const unit = this.worldPerPixel();
        const fx = Math.sin(this.azimuth), fy = Math.cos(this.azimuth);
        const stretch = 1 / Math.max(0.25, Math.cos(this.tilt));
        this.target.x += (-dx * fy + dy * fx * stretch) * unit;
        this.target.y += (dx * fx + dy * fy * stretch) * unit;
        this.target.z = this.heightAt(this.target.x, this.target.y) ?? this.target.z;
      }
      this.onChange();
    });
    const finish = (event) => {
      if (drag && !drag.moved && event.type === "pointerup" && event.button === 0) this.onClick(event.clientX, event.clientY);
      drag = null;
    };
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
    el.addEventListener("wheel", (event) => {
      event.preventDefault();
      this.flight = null;
      const factor = Math.exp(Math.sign(event.deltaY) * Math.min(1, Math.abs(event.deltaY) / 100) * 0.16);
      const point = this.globeBlend === 0 ? this._groundPoint(event.clientX, event.clientY) : null;
      const next = THREE.MathUtils.clamp(this.distance * factor, 25, 22000000);
      if (point) {
        const share = 1 - next / this.distance;
        this.target.x += (point.x - this.target.x) * share;
        this.target.y += (point.y - this.target.y) * share;
        this.target.z = this.heightAt(this.target.x, this.target.y) ?? this.target.z;
      }
      this.distance = next;
      if (this.globeBlend === 0) { this.globeLon = 0; this.globeLat = 0; }
      this.onChange();
    }, { passive: false });
  }
}
