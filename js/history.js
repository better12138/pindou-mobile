// 编辑历史：按「改动补丁」记录，而不是整图快照，110 格也不占内存。
// 每条记录：{ cells: [{ i, from, to }], done: [{ i, from, to }] }
const DEFAULT_LIMIT = 40;

export class EditHistory {
  constructor(limit = DEFAULT_LIMIT) {
    this.limit = Math.max(30, limit);
    this.undoStack = [];
    this.redoStack = [];
    this.onChange = null;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  push(record) {
    if (!record) return false;
    const cells = record.cells || [];
    const done = record.done || [];
    if (!cells.length && !done.length) return false;
    this.undoStack.push({ cells, done });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.emit();
    return true;
  }

  undo(project) {
    const record = this.undoStack.pop();
    if (!record) return null;
    apply(project, record, 'from');
    this.redoStack.push(record);
    this.emit();
    return record;
  }

  redo(project) {
    const record = this.redoStack.pop();
    if (!record) return null;
    apply(project, record, 'to');
    this.undoStack.push(record);
    this.emit();
    return record;
  }

  emit() {
    if (this.onChange) this.onChange({ canUndo: this.canUndo, canRedo: this.canRedo });
  }
}

function apply(project, record, key) {
  for (const cell of record.cells) {
    project.cells[cell.i] = cell[key];
  }
  if (project.done) {
    for (const cell of record.done) {
      project.done[cell.i] = cell[key];
    }
  }
}

/** 记录一格的变化；from/to 相同则不记录。 */
export function cellChange(project, index, to) {
  const from = project.cells[index] || null;
  if (from === (to || null)) return null;
  return { i: index, from, to: to || null };
}

/** 记录一格的勾选状态变化。 */
export function doneChange(project, index, to) {
  const from = project.done[index] ? 1 : 0;
  const value = to ? 1 : 0;
  if (from === value) return null;
  return { i: index, from, to: value };
}

export function compact(list) {
  return list.filter(Boolean);
}
