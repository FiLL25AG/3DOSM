// Sesyjna edycja tagów. Stan istnieje tylko w pamięci strony i nigdy nie jest wysyłany na serwer.

export class EditSession {
  constructor() {
    this.overlays = new Map(); // featureId -> Map(key -> wartość | null dla usunięcia)
    this.undoStack = [];
    this.redoStack = [];
  }

  get hasChanges() { return this.overlays.size > 0; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  effectiveTags(featureId, sourceTags) {
    const overlay = this.overlays.get(featureId);
    if (!overlay) return sourceTags;
    const result = { ...sourceTags };
    for (const [key, value] of overlay) {
      if (value === null) delete result[key];
      else result[key] = value;
    }
    return result;
  }

  _write(featureId, key, value, sourceTags) {
    let overlay = this.overlays.get(featureId);
    const same = value === null ? !(key in sourceTags) : sourceTags[key] === value;
    if (same) {
      overlay?.delete(key);
      if (overlay?.size === 0) this.overlays.delete(featureId);
      return;
    }
    if (!overlay) this.overlays.set(featureId, (overlay = new Map()));
    overlay.set(key, value);
  }

  _apply(featureId, changes, sourceTags, direction) {
    for (const change of direction === "undo" ? [...changes].reverse() : changes) {
      this._write(featureId, change.key, direction === "undo" ? change.before : change.after, sourceTags);
    }
  }

  /** Grupa zmian jest jednym krokiem cofania. `after === null` usuwa tag. */
  commit(featureId, sourceTags, requested, label) {
    const current = this.effectiveTags(featureId, sourceTags);
    const changes = requested
      .map(({ key, after }) => ({ key, before: current[key] ?? null, after }))
      .filter((change) => change.before !== change.after);
    if (!changes.length) return false;
    this._apply(featureId, changes, sourceTags, "redo");
    this.undoStack.push({ featureId, changes, label });
    this.redoStack.length = 0;
    return true;
  }

  setTag(featureId, sourceTags, key, value) {
    return this.commit(featureId, sourceTags, [{ key, after: value }], `Ustawienie ${key}`);
  }

  deleteTag(featureId, sourceTags, key) {
    return this.commit(featureId, sourceTags, [{ key, after: null }], `Usunięcie ${key}`);
  }

  renameTag(featureId, sourceTags, oldKey, newKey) {
    const value = this.effectiveTags(featureId, sourceTags)[oldKey];
    if (value === undefined || oldKey === newKey) return false;
    return this.commit(featureId, sourceTags, [{ key: oldKey, after: null }, { key: newKey, after: value }], `Zmiana klucza ${oldKey}`);
  }

  restoreTag(featureId, sourceTags, key) {
    return this.commit(featureId, sourceTags, [{ key, after: sourceTags[key] ?? null }], `Przywrócenie ${key}`);
  }

  restoreFeature(featureId, sourceTags) {
    const overlay = this.overlays.get(featureId);
    if (!overlay) return false;
    return this.commit(featureId, sourceTags, [...overlay.keys()].map((key) => ({ key, after: sourceTags[key] ?? null })), "Przywrócenie obiektu");
  }

  undo(sourceTagsOf) {
    const step = this.undoStack.pop();
    if (!step) return null;
    this._apply(step.featureId, step.changes, sourceTagsOf(step.featureId), "undo");
    this.redoStack.push(step);
    return step.featureId;
  }

  redo(sourceTagsOf) {
    const step = this.redoStack.pop();
    if (!step) return null;
    this._apply(step.featureId, step.changes, sourceTagsOf(step.featureId), "redo");
    this.undoStack.push(step);
    return step.featureId;
  }

  discardAll() {
    const changed = [...this.overlays.keys()];
    this.overlays.clear();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    return changed;
  }

  diff(featureId, sourceTags) {
    const current = this.effectiveTags(featureId, sourceTags);
    const keys = [...new Set([...Object.keys(sourceTags), ...Object.keys(current)])].sort();
    return keys.map((key) => {
      const source = sourceTags[key] ?? null;
      const value = current[key] ?? null;
      const status = source === value ? "bez zmian" : source === null ? "dodany" : value === null ? "usunięty" : "zmieniony";
      return { key, source, value, status };
    });
  }

  changedFeatureCount() { return this.overlays.size; }
}
