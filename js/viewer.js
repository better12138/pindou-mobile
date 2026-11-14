// 图纸画布：双指缩放 / 拖动 / 点按勾选，按需重绘。
import { getColor } from './palette.js';

export const MIN_SCALE = 0.35;
export const MAX_SCALE = 46;

/**
 * 取景计算：x/y 必须共用同一个 scale，任何输入比例下格子都是正方形。
 * 抽成纯函数，bench 可直接断言「渲染格宽高比 = 图纸比例」。
 */
export function computeFit(viewWidth, viewHeight, gridWidth, gridHeight) {
  const raw = Math.min((viewWidth - 24) / gridWidth, (viewHeight - 24) / gridHeight);
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, raw));
  return {
    scale,
    tx: (viewWidth - gridWidth * scale) / 2,
    ty: (viewHeight - gridHeight * scale) / 2,
  };
}

const LONG_PRESS_MS = 420;
const TAP_SLOP = 8;
const DOUBLE_TAP_MS = 320;

export class BoardViewer {
  constructor(canvas, { onTapCell, onViewChange, onStroke, onLongPressStart, onLongPressMove, onLongPressEnd } = {}) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.onTapCell = onTapCell || (() => {});
    this.onViewChange = onViewChange || (() => {});
    this.onStroke = onStroke || (() => {});
    this.onLongPressStart = onLongPressStart || (() => {});
    this.onLongPressMove = onLongPressMove || (() => {});
    this.onLongPressEnd = onLongPressEnd || (() => {});
    this.project = null;
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.filter = null;
    this.options = { showGrid: true, showCodes: false, beadStyle: true };
    this.compare = null;
    // 画笔态的局部提示：当前工具、当前色、落笔焦点。
    this.editTool = 'view';
    this.paintColor = null;
    this.focus = null;
    this.focusTimer = 0;
    this.pointers = new Map();
    this.pinch = null;
    this.pan = null;
    this.dirty = true;
    this.frame = 0;
    this.painting = false;
    this.strokeIndex = -1;
    // 长按手势：按下后先不落笔，超过阈值才算笔画，避免「长按吸色」先误涂一格。
    this.pending = null;
    this.longPressTimer = 0;
    this.tempPick = false;
    this.tempPickIndex = -1;
    this.lastTap = null;
    // 双指手势结束后，剩下的一根手指不应该继续涂色。
    this.suppressGesture = false;
    this.bind();
    this.observeResize();
  }

  /** 编辑工具激活时，单指点按/拖动直接落在格子上；双指仍用于缩放拖动。 */
  setPainting(active) {
    this.painting = Boolean(active);
    if (!this.painting) {
      this.strokeIndex = -1;
      this.clearPending();
    }
  }

  clearPending() {
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    this.longPressTimer = 0;
    this.pending = null;
  }

  /** 按下后记录起点并启动长按计时；移动超过阈值或抬起时取消。 */
  startPending(point) {
    const index = this.cellFromLocal(point);
    if (index === null) return;
    this.clearPending();
    this.pending = { index, point, moved: false, painted: false };
    this.longPressTimer = setTimeout(() => this.fireLongPress(), LONG_PRESS_MS);
  }

  fireLongPress() {
    this.longPressTimer = 0;
    const pending = this.pending;
    if (!pending || this.pointers.size !== 1 || this.pinch) return;
    this.pending = null;
    this.pan = null;
    this.tempPick = true;
    this.tempPickIndex = pending.index;
    this.onLongPressStart(pending.index);
  }

  beginStrokeAt(index) {
    this.strokeIndex = index;
    this.onStroke('start', index);
  }

  setProject(project) {
    this.project = project;
    this.fit();
  }

  setOptions(patch) {
    Object.assign(this.options, patch);
    this.dirty = true;
  }

  setFilter(colorId) {
    this.filter = colorId || null;
    this.dirty = true;
  }

  /** 画笔态只用局部提示，不再对整图做全局压暗/降饱和。 */
  setEditTool(tool) {
    this.editTool = tool || 'view';
    if (this.editTool === 'view' && !this.painting) this.clearFocus();
    this.dirty = true;
  }

  setPaintColor(colorId) {
    this.paintColor = colorId || null;
    this.dirty = true;
  }

  keepFocus(index) {
    if (index === null || index === undefined) return;
    const project = this.project;
    if (!project) return;
    this.focus = { x: index % project.width, y: Math.floor(index / project.width) };
    if (this.focusTimer) clearTimeout(this.focusTimer);
    this.focusTimer = 0;
    this.dirty = true;
  }

  /** 松手后保留一小段时间，让最后一格的光标位置可被看到。 */
  dropFocusSoon() {
    if (!this.focus) return;
    if (this.focusTimer) clearTimeout(this.focusTimer);
    this.focusTimer = setTimeout(() => {
      this.focus = null;
      this.focusTimer = 0;
      this.dirty = true;
    }, 260);
  }

  clearFocus() {
    if (this.focusTimer) clearTimeout(this.focusTimer);
    this.focusTimer = 0;
    this.focus = null;
    this.dirty = true;
  }

  /** 原图对照：mode 为 overlay（半透明叠加）或 split（左原图 / 右图纸）。 */
  setCompare(image, mode) {
    this.compare = image && mode && mode !== 'off' ? { image, mode } : null;
    this.dirty = true;
  }

  fit() {
    if (!this.project) return;
    const width = this.canvas.clientWidth || 360;
    const height = this.canvas.clientHeight || 360;
    const { width: gw, height: gh } = this.project;
    const fit = computeFit(width, height, gw, gh);
    this.scale = fit.scale;
    this.tx = fit.tx;
    this.ty = fit.ty;
    this.userAdjusted = false;
    this.dirty = true;
    this.onViewChange(this.zoomLabel());
  }

  zoomAt(factor, cx, cy) {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const x = cx ?? width / 2;
    const y = cy ?? height / 2;
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * factor));
    if (next === this.scale) return;
    const worldX = (x - this.tx) / this.scale;
    const worldY = (y - this.ty) / this.scale;
    this.scale = next;
    this.tx = x - worldX * next;
    this.ty = y - worldY * next;
    this.userAdjusted = true;
    this.dirty = true;
    this.onViewChange(this.zoomLabel());
  }

  zoomLabel() {
    return `×${this.scale < 10 ? this.scale.toFixed(1) : Math.round(this.scale)}`;
  }

  observeResize() {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
    });
    this.resizeObserver.observe(this.canvas);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (!width || !height) return;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.dpr = dpr;
    this.dirty = true;
    // 用户还没手动缩放/拖动时，跟着容器尺寸重新适配，避免首屏按错误尺寸取景。
    if (this.project && !this.userAdjusted) this.fit();
  }

  bind() {
    const canvas = this.canvas;
    canvas.style.touchAction = 'none';

    // 指针坐标统一换算到画布本地坐标，避免画布不在页面原点时缩放跳动。
    const localPoint = (event) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    canvas.addEventListener('pointerdown', (event) => {
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // 个别浏览器/合成事件下捕获会失败，不影响后续手势
      }
      const point = localPoint(event);
      this.pointers.set(event.pointerId, point);

      // 第二根手指落下：临时吸管立即结束，正在画的笔画收尾，手势交还给缩放/拖动。
      if (this.tempPick) {
        this.tempPick = false;
        this.tempPickIndex = -1;
        this.onLongPressEnd();
      }
      if (this.pointers.size === 2) {
        this.clearPending();
        if (this.strokeIndex >= 0) {
          this.strokeIndex = -1;
          this.onStroke('end');
        }
      }

      if (this.pointers.size === 1) {
        this.pinch = null;
        if (this.painting) {
          this.pan = null;
          this.startPending(point);
          this.keepFocus(this.cellFromLocal(point));
          return;
        }
        this.pan = { x: point.x, y: point.y, tx: this.tx, ty: this.ty, moved: false, at: Date.now() };
        // 浏览模式也能长按临时吸管。
        this.startPending(point);
      } else if (this.pointers.size === 2) {
        this.suppressGesture = true;
        this.clearFocus();
        const [a, b] = [...this.pointers.values()];
        this.pinch = {
          distance: Math.hypot(a.x - b.x, a.y - b.y),
          scale: this.scale,
          midX: (a.x + b.x) / 2,
          midY: (a.y + b.y) / 2,
          tx: this.tx,
          ty: this.ty,
        };
        this.pan = null;
      }
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!this.pointers.has(event.pointerId)) return;
      const pointer = localPoint(event);
      this.pointers.set(event.pointerId, pointer);

      // 长按临时吸管：按住移动时连续取色。
      if (this.tempPick) {
        const index = this.cellFromLocal(pointer);
        if (index !== null) this.keepFocus(index);
        if (index !== null && index !== this.tempPickIndex) {
          this.tempPickIndex = index;
          this.onLongPressMove(index);
        }
        return;
      }

      // 手指一旦移动超过阈值就取消长按，避免正常涂色被误判。
      if (this.pending && Math.abs(pointer.x - this.pending.point.x) + Math.abs(pointer.y - this.pending.point.y) > TAP_SLOP) {
        this.pending.moved = true;
        if (this.longPressTimer) clearTimeout(this.longPressTimer);
        this.longPressTimer = 0;
      }

      if (this.painting && this.pointers.size === 1) {
        if (this.suppressGesture) return;
        const index = this.cellFromLocal(pointer);
        if (index === null) return;
        this.keepFocus(index);
        if (!this.pending) {
          // 起手在格子外、移动进格子：从当前格开始画。
          if (this.strokeIndex < 0) this.beginStrokeAt(index);
          else if (index !== this.strokeIndex) {
            this.strokeIndex = index;
            this.onStroke('move', index);
          }
          return;
        }
        if (!this.pending.painted) {
          // 第一次移动才真正落笔，先补上起点格。
          this.pending.painted = true;
          const start = this.pending.index;
          this.beginStrokeAt(start);
          if (index !== start) {
            this.strokeIndex = index;
            this.onStroke('move', index);
          }
          return;
        }
        if (index !== this.strokeIndex) {
          this.strokeIndex = index;
          this.onStroke('move', index);
        }
        return;
      }

      if (this.pointers.size >= 2 && this.pinch) {
        const [a, b] = [...this.pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, (this.pinch.scale * distance) / this.pinch.distance));
        const worldX = (this.pinch.midX - this.pinch.tx) / this.pinch.scale;
        const worldY = (this.pinch.midY - this.pinch.ty) / this.pinch.scale;
        this.scale = nextScale;
        this.tx = midX - worldX * nextScale;
        this.ty = midY - worldY * nextScale;
        this.userAdjusted = true;
        this.dirty = true;
        this.onViewChange(this.zoomLabel());
        return;
      }

      if (this.pointers.size === 1 && this.pan) {
        const dx = (pointer.x || 0) - this.pan.x;
        const dy = (pointer.y || 0) - this.pan.y;
        if (Math.abs(dx) + Math.abs(dy) > 6) {
          this.pan.moved = true;
          this.userAdjusted = true;
          this.lastTap = null;
        }
        this.tx = this.pan.tx + dx;
        this.ty = this.pan.ty + dy;
        this.dirty = true;
      }
    });

    const release = (event) => {
      const pointer = this.pointers.get(event.pointerId);
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) this.pinch = null;

      // 临时吸管：松手回到原工具，不落笔也不触发点按。
      if (this.tempPick) {
        this.tempPick = false;
        this.tempPickIndex = -1;
        this.clearPending();
        this.pan = null;
        if (this.pointers.size === 1) {
          const [remaining] = [...this.pointers.values()];
          this.pan = { x: remaining.x, y: remaining.y, tx: this.tx, ty: this.ty, moved: true, at: Date.now() };
        }
        this.onLongPressEnd();
        this.dropFocusSoon();
        return;
      }

      // 单指抬起的点按：延迟到抬手才落笔，长按已经提前接管。
      if (this.pointers.size === 0 && this.pending) {
        const pending = this.pending;
        this.clearPending();
        if (this.painting) {
          if (!pending.painted) {
            this.beginStrokeAt(pending.index);
            this.strokeIndex = -1;
            this.onStroke('end');
          } else if (this.strokeIndex >= 0) {
            this.strokeIndex = -1;
            this.onStroke('end');
          }
          this.pan = null;
          this.dropFocusSoon();
          return;
        }
      }

      if (this.pointers.size === 0 && this.strokeIndex >= 0) {
        this.strokeIndex = -1;
        this.pan = null;
        this.onStroke('end');
        this.dropFocusSoon();
        return;
      }

      if (this.pointers.size === 0 && this.pan && pointer && !this.pan.moved && Date.now() - this.pan.at < 450) {
        this.lastPointerTap = Date.now();
        const now = Date.now();
        const last = this.lastTap;
        const isDouble =
          last && now - last.time < DOUBLE_TAP_MS && Math.hypot(pointer.x - last.x, pointer.y - last.y) < 30;
        if (isDouble) {
          this.lastTap = null;
          // 双击放大；已经接近最大倍率时回到适应屏幕。
          if (this.scale >= MAX_SCALE * 0.9) this.fit();
          else this.zoomAt(2, pointer.x, pointer.y);
        } else {
          this.lastTap = { time: now, x: pointer.x, y: pointer.y };
          this.handleTap(pointer.x + canvas.getBoundingClientRect().left, pointer.y + canvas.getBoundingClientRect().top);
        }
      }
      if (this.pointers.size === 0) {
        this.pan = null;
        this.suppressGesture = false;
      } else if (this.pointers.size === 1) {
        const [remaining] = [...this.pointers.values()];
        this.pan = { x: remaining.x, y: remaining.y, tx: this.tx, ty: this.ty, moved: true, at: Date.now() };
      }
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        this.zoomAt(event.deltaY < 0 ? 1.14 : 1 / 1.14, event.clientX - rect.left, event.clientY - rect.top);
      },
      { passive: false },
    );

    // 兼容只派发 click（无 Pointer Events）的环境；真实触摸/鼠标点击走 pointerup，避免重复触发。
    canvas.addEventListener('click', (event) => {
      if (Date.now() - (this.lastPointerTap || 0) < 700) return;
      this.handleTap(event.clientX, event.clientY);
    });
  }

  cellFromLocal(point) {
    if (!this.project) return null;
    const x = Math.floor((point.x - this.tx) / this.scale);
    const y = Math.floor((point.y - this.ty) / this.scale);
    if (x < 0 || y < 0 || x >= this.project.width || y >= this.project.height) return null;
    return y * this.project.width + x;
  }

  handleTap(clientX, clientY) {
    if (!this.project) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left - this.tx) / this.scale);
    const y = Math.floor((clientY - rect.top - this.ty) / this.scale);
    if (x < 0 || y < 0 || x >= this.project.width || y >= this.project.height) return;
    this.onTapCell(y * this.project.width + x);
  }

  /** 启动渲染循环。 */
  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.draw();
      this.frame = requestAnimationFrame(loop);
    };
    this.frame = requestAnimationFrame(loop);
  }

  /** 停止渲染循环。 */
  stop() {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  /** 标记重绘（手势/勾选后调用）。 */
  invalidate() {
    this.dirty = true;
  }

  draw() {
    if (!this.dirty) return;
    this.dirty = false;
    const ctx = this.context;
    const dpr = this.dpr || 1;
    const width = this.canvas.width / dpr;
    const height = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // 工作台底色（奶油白 / 藕粉，与界面主题一致）
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#fdf9f5');
    gradient.addColorStop(1, '#f4e9e3');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    const project = this.project;
    if (!project) return;

    const cell = this.scale;
    const startX = Math.max(0, Math.floor(-this.tx / cell));
    const startY = Math.max(0, Math.floor(-this.ty / cell));
    const endX = Math.min(project.width, Math.ceil((width - this.tx) / cell));
    const endY = Math.min(project.height, Math.ceil((height - this.ty) / cell));

    // 图纸底：空格也画一层浅底，方便判断边界
    ctx.fillStyle = 'rgba(92,64,74,0.05)';
    ctx.fillRect(this.tx, this.ty, project.width * cell, project.height * cell);

    const bead = this.options.beadStyle && cell >= 5;
    const drawCodes = this.options.showCodes && cell >= 19;
    const drawDone = cell >= 7 && project.done;
    const filter = this.filter;
    const baseAlpha = filter ? 0.16 : 1;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let y = startY; y < endY; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        const index = y * project.width + x;
        const id = project.cells[index];
        if (!id) continue;
        const color = getColor(id);
        if (!color) continue;
        const px = this.tx + x * cell;
        const py = this.ty + y * cell;
        const isFilterMatch = !filter || filter === id;
        ctx.globalAlpha = isFilterMatch ? baseAlpha : baseAlpha * 0.7;

        if (bead) {
          const radius = cell * 0.44;
          const cx = px + cell / 2;
          const cy = py + cell / 2;
          ctx.beginPath();
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          ctx.fillStyle = color.hex;
          ctx.fill();
          if (cell >= 11) {
            ctx.beginPath();
            ctx.arc(cx, cy, radius * 0.99, Math.PI * 0.72, Math.PI * 1.62);
            ctx.strokeStyle = 'rgba(255,255,255,0.45)';
            ctx.lineWidth = Math.max(1, cell * 0.06);
            ctx.stroke();
          }
        } else {
          ctx.fillStyle = color.hex;
          ctx.fillRect(px, py, Math.ceil(cell), Math.ceil(cell));
        }

        if (drawDone && project.done[index]) {
          ctx.globalAlpha = isFilterMatch ? 1 : 0.5;
          ctx.fillStyle = 'rgba(255,253,251,0.74)';
          if (bead) {
            ctx.beginPath();
            ctx.arc(px + cell / 2, py + cell / 2, cell * 0.46, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillRect(px, py, Math.ceil(cell), Math.ceil(cell));
          }
          if (cell >= 8) {
            ctx.strokeStyle = '#1f6b4e';
            ctx.lineWidth = Math.max(1, cell * 0.1);
            ctx.beginPath();
            ctx.moveTo(px + cell * 0.28, py + cell * 0.52);
            ctx.lineTo(px + cell * 0.44, py + cell * 0.68);
            ctx.lineTo(px + cell * 0.74, py + cell * 0.32);
            ctx.stroke();
          }
        }

        if (drawCodes && isFilterMatch) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = contrastText(color.rgb);
          const size = Math.min(cell * 0.46, 13);
          ctx.font = `600 ${size}px ui-sans-serif, system-ui, -apple-system, "PingFang SC", sans-serif`;
          ctx.fillText(color.code, px + cell / 2, py + cell / 2 + size * 0.04);
        }
      }
    }
    ctx.globalAlpha = 1;

    // 网格线
    if (this.options.showGrid && cell >= 6) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(92,64,74,0.16)';
      ctx.beginPath();
      for (let x = startX; x <= endX; x += 1) {
        const px = Math.round(this.tx + x * cell) + 0.5;
        ctx.moveTo(px, Math.max(this.ty, 0));
        ctx.lineTo(px, Math.min(this.ty + project.height * cell, height));
      }
      for (let y = startY; y <= endY; y += 1) {
        const py = Math.round(this.ty + y * cell) + 0.5;
        ctx.moveTo(Math.max(this.tx, 0), py);
        ctx.lineTo(Math.min(this.tx + project.width * cell, width), py);
      }
      ctx.stroke();
    }

    // 拼豆底板分界（5mm 板 29×29），只在图纸范围内画，避免越界成多余长线
    if (cell >= 4) {
      const left = Math.max(this.tx, 0);
      const right = Math.min(this.tx + project.width * cell, width);
      const top = Math.max(this.ty, 0);
      const bottom = Math.min(this.ty + project.height * cell, height);
      ctx.strokeStyle = 'rgba(201,58,110,0.4)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let x = 0; x <= project.width; x += 29) {
        const px = Math.round(this.tx + x * cell) + 0.5;
        ctx.moveTo(px, top);
        ctx.lineTo(px, bottom);
      }
      for (let y = 0; y <= project.height; y += 29) {
        const py = Math.round(this.ty + y * cell) + 0.5;
        ctx.moveTo(left, py);
        ctx.lineTo(right, py);
      }
      ctx.stroke();
    }

    // 只在当前色数量不占多数时做轻描边，避免给背景色描出一整张网。
    this.drawPaintOutline(ctx, project, startX, startY, endX, endY);
    this.drawFocus(ctx, project);

    this.drawCompare(ctx, project, width, height);
  }

  /** 当前画笔色的轻微外描边：局部提示，不改动任何格子的填充色。 */
  drawPaintOutline(ctx, project, startX, startY, endX, endY) {
    if (this.editTool !== 'brush' && this.editTool !== 'bucket') return;
    if (!this.paintColor || this.scale < 6) return;
    let total = 0;
    let match = 0;
    for (const id of project.cells) {
      if (!id) continue;
      total += 1;
      if (id === this.paintColor) match += 1;
    }
    // 背景色往往占一半以上，全部描边会变成噪声；只给「少数色」做定位。
    if (!match || !total || match / total > 0.45) return;
    const color = getColor(this.paintColor);
    if (!color) return;
    const cell = this.scale;
    const light = 0.299 * color.rgb[0] + 0.587 * color.rgb[1] + 0.114 * color.rgb[2] > 160;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = light ? 'rgba(92,64,74,0.35)' : 'rgba(255,255,255,0.52)';
    ctx.lineWidth = Math.max(1, cell * 0.08);
    for (let y = startY; y < endY; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        if (project.cells[y * project.width + x] !== this.paintColor) continue;
        const cx = this.tx + (x + 0.5) * cell;
        const cy = this.ty + (y + 0.5) * cell;
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.44 + Math.max(0.7, cell * 0.05), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** 落笔焦点：5×5 范围内网格提亮 + 外框 + 当前格圆环。 */
  drawFocus(ctx, project) {
    const focus = this.focus;
    if (!focus) return;
    const cell = this.scale;
    if (cell < 4) return;
    // 填充是点区域，不需要 5×5 的笔刷范围；只标出种子格。
    const span = this.editTool === 'bucket' ? 0 : 2;
    const x0 = Math.max(0, focus.x - span);
    const x1 = Math.min(project.width, focus.x + span + 1);
    const y0 = Math.max(0, focus.y - span);
    const y1 = Math.min(project.height, focus.y + span + 1);
    const left = this.tx + x0 * cell;
    const top = this.ty + y0 * cell;
    const w = (x1 - x0) * cell;
    const h = (y1 - y0) * cell;
    const accent =
      this.editTool === 'eraser'
        ? 'rgba(92,64,74,0.75)'
        : this.editTool === 'mark'
          ? 'rgba(31,107,78,0.82)'
          : 'rgba(201,58,110,0.78)';

    ctx.save();
    ctx.globalAlpha = 1;

    if (this.options.showGrid && cell >= 6) {
      // 先铺一层暖白，再压一层细的玫瑰色，深色/浅色格子上都能看出提亮。
      ctx.strokeStyle = 'rgba(255,253,251,0.88)';
      ctx.lineWidth = Math.max(1.6, cell * 0.1);
      ctx.beginPath();
      for (let x = x0; x <= x1; x += 1) {
        const px = Math.round(this.tx + x * cell) + 0.5;
        ctx.moveTo(px, top);
        ctx.lineTo(px, top + h);
      }
      for (let y = y0; y <= y1; y += 1) {
        const py = Math.round(this.ty + y * cell) + 0.5;
        ctx.moveTo(left, py);
        ctx.lineTo(left + w, py);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(201,58,110,0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(left, top, w, h, 8);
      ctx.stroke();
    } else {
      ctx.strokeRect(left, top, w, h);
    }

    const cx = this.tx + (focus.x + 0.5) * cell;
    const cy = this.ty + (focus.y + 0.5) * cell;
    const radius = cell * 0.47;
    ctx.strokeStyle = 'rgba(255,253,251,0.95)';
    ctx.lineWidth = Math.max(2, cell * 0.12);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = accent;
    ctx.lineWidth = Math.max(1.2, cell * 0.07);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** 原图对照层：叠加时半透明盖在图纸上；左右模式左半边显示原图并画分界线。 */
  drawCompare(ctx, project, width, height) {
    const compare = this.compare;
    const image = compare && compare.image;
    if (!image || !image.complete || !image.naturalWidth) return;
    const cell = this.scale;
    const x = this.tx;
    const y = this.ty;
    const w = project.width * cell;
    const h = project.height * cell;
    if (w <= 0 || h <= 0) return;

    ctx.save();
    if (compare.mode === 'split') {
      ctx.beginPath();
      ctx.rect(0, 0, x + w / 2, height);
      ctx.clip();
      ctx.drawImage(image, x, y, w, h);
      ctx.restore();

      const divider = Math.round(x + w / 2) + 0.5;
      const top = Math.max(y, 0);
      const bottom = Math.min(y + h, height);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(divider, top);
      ctx.lineTo(divider, bottom);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(201, 58, 110, 0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(divider, top);
      ctx.lineTo(divider, bottom);
      ctx.stroke();
    } else {
      ctx.globalAlpha = 0.55;
      ctx.drawImage(image, x, y, w, h);
      ctx.restore();
    }
  }
}

function contrastText([r, g, b]) {
  const value = 0.299 * r + 0.587 * g + 0.114 * b;
  return value > 150 ? 'rgba(20,22,26,0.86)' : 'rgba(255,255,255,0.92)';
}
