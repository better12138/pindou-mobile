// 生成前取景：单指拖动、双指缩放、90° 旋转，框内区域按原图分辨率裁出。
const MIN_COVER = 1;
const MAX_SCALE_FACTOR = 6;

export class CropTool {
  constructor({ stage, canvas, frame }) {
    this.stage = stage;
    this.canvas = canvas;
    this.frame = frame;
    this.context = canvas.getContext('2d');
    this.image = null;
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.aspect = 'original';
    this.pointers = new Map();
    this.gesture = null;
    this.bind();
  }

  setAspect(aspect) {
    this.aspect = aspect;
    this.layout();
    this.cover();
    this.render();
  }

  open(image) {
    this.image = image;
    this.tx = 0;
    this.ty = 0;
    this.layout();
    this.resize();
    this.cover();
    this.render();
  }

  rotate() {
    if (!this.image) return;
    const source = this.image;
    const canvas = document.createElement('canvas');
    canvas.width = source.naturalHeight || source.height;
    canvas.height = source.naturalWidth || source.width;
    const context = canvas.getContext('2d');
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(Math.PI / 2);
    context.drawImage(source, -source.naturalWidth / 2, -source.naturalHeight / 2);
    this.image = canvas;
    this.tx = 0;
    this.ty = 0;
    this.layout();
    this.cover();
    this.render();
  }

  reset() {
    this.tx = 0;
    this.ty = 0;
    this.cover();
    this.render();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (!width || !height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.dpr = dpr;
    this.layout();
    this.render();
  }

  /** 按画布尺寸摆好裁剪框（最大占 88%）。 */
  layout() {
    if (!this.width || !this.height) {
      this.width = this.canvas.clientWidth || 320;
      this.height = this.canvas.clientHeight || 300;
    }
    const ratio = this.aspectRatio();
    let frameWidth = this.width * 0.88;
    let frameHeight = frameWidth / ratio;
    if (frameHeight > this.height * 0.82) {
      frameHeight = this.height * 0.82;
      frameWidth = frameHeight * ratio;
    }
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    const left = (this.width - frameWidth) / 2;
    const top = (this.height - frameHeight) / 2;
    Object.assign(this.frame.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${frameWidth}px`,
      height: `${frameHeight}px`,
    });
    this.frameRect = { left, top, width: frameWidth, height: frameHeight };
  }

  aspectRatio() {
    const image = this.image;
    const natural = image ? (image.naturalWidth || image.width) / (image.naturalHeight || image.height) : 1;
    if (this.aspect === '1:1') return 1;
    if (this.aspect === '4:3') return 4 / 3;
    if (this.aspect === '3:4') return 3 / 4;
    return natural;
  }

  imageSize() {
    return {
      width: this.image.naturalWidth || this.image.width,
      height: this.image.naturalHeight || this.image.height,
    };
  }

  /** 最小缩放：保证画面完全覆盖裁剪框。 */
  coverScale() {
    const { width, height } = this.imageSize();
    return Math.max(this.frameWidth / width, this.frameHeight / height);
  }

  cover() {
    this.scale = this.coverScale() * MIN_COVER;
    this.clamp();
  }

  clamp() {
    if (!this.image) return;
    const { width, height } = this.imageSize();
    const cx = this.width / 2 + this.tx;
    const cy = this.height / 2 + this.ty;
    const halfW = (width * this.scale) / 2;
    const halfH = (height * this.scale) / 2;
    const { left, top, width: fw, height: fh } = this.frameRect;
    const minTx = left + fw - this.width / 2 - halfW;
    const maxTx = left - this.width / 2 + halfW;
    const minTy = top + fh - this.height / 2 - halfH;
    const maxTy = top - this.height / 2 + halfH;
    this.tx = Math.min(maxTx, Math.max(minTx, this.tx));
    this.ty = Math.min(maxTy, Math.max(minTy, this.ty));
    // 画面比框还小时（理论上不会发生），居中兜底。
    if (cx - halfW > left || cx + halfW < left + fw) this.tx = 0;
    if (cy - halfH > top || cy + halfH < top + fh) this.ty = 0;
  }

  render() {
    if (!this.image) return;
    const context = this.context;
    const dpr = this.dpr || 1;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, this.width, this.height);
    context.fillStyle = '#0b0e12';
    context.fillRect(0, 0, this.width, this.height);
    const { width, height } = this.imageSize();
    const drawWidth = width * this.scale;
    const drawHeight = height * this.scale;
    const x = this.width / 2 + this.tx - drawWidth / 2;
    const y = this.height / 2 + this.ty - drawHeight / 2;
    context.imageSmoothingEnabled = this.scale < 1;
    context.drawImage(this.image, x, y, drawWidth, drawHeight);
  }

  /** 把裁剪框映射回原图坐标并导出。 */
  apply() {
    if (!this.image) return null;
    const { width, height } = this.imageSize();
    const { left, top, width: fw, height: fh } = this.frameRect;
    const sourceX = (left - (this.width / 2 + this.tx)) / this.scale + width / 2;
    const sourceY = (top - (this.height / 2 + this.ty)) / this.scale + height / 2;
    const sourceW = fw / this.scale;
    const sourceH = fh / this.scale;
    const maxSide = 1600;
    const ratio = Math.min(1, maxSide / Math.max(sourceW, sourceH));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceW * ratio));
    canvas.height = Math.max(1, Math.round(sourceH * ratio));
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.drawImage(this.image, sourceX, sourceY, sourceW, sourceH, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  bind() {
    const canvas = this.canvas;
    canvas.style.touchAction = 'none';
    const local = (event) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    canvas.addEventListener('pointerdown', (event) => {
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // 忽略捕获失败
      }
      const point = local(event);
      this.pointers.set(event.pointerId, point);
      if (this.pointers.size === 1) {
        this.gesture = { mode: 'pan', x: point.x, y: point.y, tx: this.tx, ty: this.ty };
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.gesture = {
          mode: 'pinch',
          distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          scale: this.scale,
          midX: (a.x + b.x) / 2,
          midY: (a.y + b.y) / 2,
          tx: this.tx,
          ty: this.ty,
        };
      }
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!this.pointers.has(event.pointerId) || !this.gesture) return;
      const point = local(event);
      this.pointers.set(event.pointerId, point);
      if (this.gesture.mode === 'pan' && this.pointers.size === 1) {
        this.tx = this.gesture.tx + (point.x - this.gesture.x);
        this.ty = this.gesture.ty + (point.y - this.gesture.y);
        this.clamp();
        this.render();
        return;
      }
      if (this.gesture.mode === 'pinch' && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const min = this.coverScale();
        const next = Math.max(min, Math.min(min * MAX_SCALE_FACTOR, (this.gesture.scale * distance) / this.gesture.distance));
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        // 以两指中点为锚点缩放
        const worldX = (this.gesture.midX - (this.width / 2 + this.gesture.tx)) / this.gesture.scale;
        const worldY = (this.gesture.midY - (this.height / 2 + this.gesture.ty)) / this.gesture.scale;
        this.scale = next;
        this.tx = midX - this.width / 2 - worldX * next;
        this.ty = midY - this.height / 2 - worldY * next;
        this.clamp();
        this.render();
      }
    });

    const release = (event) => {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size === 1) {
        const [point] = [...this.pointers.values()];
        this.gesture = { mode: 'pan', x: point.x, y: point.y, tx: this.tx, ty: this.ty };
      } else if (this.pointers.size === 0) {
        this.gesture = null;
      }
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
  }
}
