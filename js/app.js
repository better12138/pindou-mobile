import { brandLabels, getColor } from './palette.js';
import { prepareSource, convertToBeads, backgroundPreview } from './convert.js';
import { convertAsync } from './convert-client.js';
import { computeUsage, progressOf } from './usage.js';
import {
  initStore,
  onStoreError,
  listProjects,
  getProject,
  saveProject,
  deleteProject,
  makeThumb,
  getSetting,
  setSetting,
} from './store.js';
import { BoardViewer } from './viewer.js';
import { exportChart, exportUsageCsv } from './export.js';
import { printProject, printCalibration, resolveCellMm, normalizePitch } from './print.js';
import { initInstall } from './install.js';
import { initEntitlement, requireExport, refreshEntitlement, bindPcLink } from './entitlement.js';
import { EditHistory, cellChange, doneChange, compact } from './history.js';
import { CropTool } from './crop.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const EDIT_TOOLS = ['mark', 'brush', 'eraser', 'picker', 'bucket'];
const TOOL_HINTS = {
  view: '双指缩放 · 双击放大',
  mark: '点或拖动标记 · 再点取消',
  brush: '单指涂色 · 长按吸色',
  eraser: '单指擦除 · 长按吸色',
  picker: '点格子吸取颜色',
  bucket: '点区域填充当前色',
};

const state = {
  project: null,
  viewer: null,
  tool: 'view',
  filter: null,
  paint: null,
  pending: null,
  saveTimer: 0,
  stroke: null,
  strokeDone: null,
  markTarget: null,
  restoreTool: null,
  tempPicked: null,
  replaceFrom: null,
  replaceTo: null,
  cropTool: null,
  wakeLock: null,
  storage: { mode: 'indexeddb', version: 3, migratedCount: 0 },
  calibration: { pitch: 5, measured10: null },
  compare: { mode: 'off', image: null },
  regenerateFrom: null,
  printStep: 1,
  lastSettings: { width: 48, colors: 16, brand: 'MARD', style: 'cartoon', background: false, speckle: 1 },
};

state.history = new EditHistory(50);

/* ---------------- 通用 UI ---------------- */

let toastTimer = 0;
function toast(message, options = {}) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', Boolean(options.error));
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), options.duration || 1900);
}

function setLoading(active, text = '正在生成图纸…') {
  $('#loading-text').textContent = text;
  $('#loading').classList.toggle('hidden', !active);
}

/** 立刻收起仍在显示的 toast，避免旧提示描述的是上一个动作。 */
function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').classList.remove('show');
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)));
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

/* ---------------- 说明弹层 ---------------- */

function openHelp({ title, html, actionText, onAction }) {
  $('#help-title').textContent = title;
  $('#help-body').innerHTML = html;
  const action = $('#help-action');
  if (actionText) {
    action.textContent = actionText;
    action.classList.remove('hidden');
    action.onclick = () => {
      closeHelp();
      if (onAction) onAction();
    };
  } else {
    action.classList.add('hidden');
  }
  $('#sheet-help').setAttribute('aria-hidden', 'false');
}

function closeHelp() {
  $('#sheet-help').setAttribute('aria-hidden', 'true');
}

$('#sheet-help').addEventListener('click', (event) => {
  if (event.target.closest('[data-close]')) closeHelp();
});

/* ---------------- 首页 ---------------- */

function renderHome() {
  const projects = listProjects();
  const list = $('#project-list');
  $('#project-count').textContent = projects.length ? `${projects.length} 张` : '';
  if (!projects.length) {
    list.innerHTML = `
      <div class="empty">
        <svg viewBox="0 0 96 96" aria-hidden="true">
          <rect x="12" y="18" width="72" height="62" rx="14" />
          <circle cx="36" cy="42" r="5" />
          <circle cx="60" cy="42" r="5" />
          <path d="M32 58c6 8 26 8 32 0" />
          <path d="M48 8v8M20 28l-5-4M76 28l5-4" />
        </svg>
        还没有图纸。<br />拍一张照片，或从相册选一张，几十秒就能生成。
      </div>`;
    return;
  }
  list.innerHTML = projects
    .map((project) => {
      const percent = project.totalBeads ? Math.round((project.doneCount / project.totalBeads) * 100) : 0;
      const thumb = project.thumb
        ? `<img class="project-thumb" src="${project.thumb}" alt="" />`
        : '<div class="project-thumb"></div>';
      return `
        <button class="project-card" data-id="${project.id}">
          ${thumb}
          <div class="project-meta">
            <div class="project-name">${escapeHtml(project.name)}</div>
            <div class="project-info">${project.width}×${project.height} · ${project.colorsUsed || 0} 色 · 已拼 ${percent}%</div>
            <div class="mini-progress"><i style="width:${percent}%"></i></div>
          </div>
        </button>`;
    })
    .join('');
}

$('#project-list').addEventListener('click', (event) => {
  const card = event.target.closest('.project-card');
  if (card) openProject(card.dataset.id);
});

/* ---------------- 选图 / 生成 ---------------- */

$('#btn-camera').addEventListener('click', () => pickFile(true));
$('#btn-pick').addEventListener('click', () => pickFile(false));

function pickFile(fromCamera) {
  const input = $('#file-input');
  if (fromCamera) input.setAttribute('capture', 'environment');
  else input.removeAttribute('capture');
  input.value = '';
  input.click();
}

const HEIC_PATTERN = /\.(hei[cf])$/i;

$('#file-input').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const looksHeic = /^image\/hei[cf]/i.test(file.type) || HEIC_PATTERN.test(file.name);
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    releasePending();
    state.regenerateFrom = null;
    state.pending = { image, url, name: file.name.replace(/\.[^.]+$/, '') || '拼豆图纸' };
    openGenerateSheet();
  } catch {
    URL.revokeObjectURL(url);
    if (looksHeic) showHeicHelp();
    else toast('这张图片打不开，换一张试试', { error: true });
  }
});

/** 浏览器解不了 HEIC 时给出可执行的替代路径，而不是只说失败。 */
function showHeicHelp() {
  openHelp({
    title: '这张 HEIC 照片打不开',
    html: `
      <p>HEIC 是 iPhone 的默认照片格式，部分浏览器没有内置解码器。</p>
      <p class="field-hint">不用装任何东西，任选一种：</p>
      <ol class="help-steps">
        <li>直接截屏，再从相册选那张截图（最省事）</li>
        <li>设置 → 相机 → 格式 → 选「兼容性最佳」，以后拍的都是 JPG</li>
        <li>把照片发到微信「文件传输助手」，另存后再选</li>
      </ol>`,
    actionText: '重新选图',
    onAction: () => pickFile(false),
  });
}

/** 换图或关掉弹层时释放上一张预处理图，避免占内存。 */
function releasePending() {
  if (state.pending && state.pending.url && state.pending.url.startsWith('blob:')) {
    URL.revokeObjectURL(state.pending.url);
  }
  state.pending = null;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('load failed'));
    image.src = url;
  });
}

$('#btn-sample').addEventListener('click', async () => {
  setLoading(true, '正在准备示例图…');
  await nextFrame();
  const image = await makeSampleImage();
  state.regenerateFrom = null;
  state.pending = { image, url: image.src, name: '示例 · 猫猫' };
  setLoading(false);
  openGenerateSheet();
});

function openGenerateSheet() {
  if (!state.pending) return;
  const { url, image } = state.pending;
  $('#preview-img').src = url;
  $('#preview-badge').textContent = `${image.naturalWidth} × ${image.naturalHeight}`;

  const settings = state.lastSettings;
  $('#opt-width').value = settings.width;
  $('#opt-colors').value = settings.colors;
  $('#opt-speckle').value = settings.speckle;
  $('#opt-background').checked = settings.background;
  setSegmented('#opt-brand', settings.brand);
  setSegmented('#opt-style', settings.style);
  syncRangeLabels();
  syncBackgroundState();
  if (settings.background) refreshBackgroundPreview();
  $('#btn-generate').textContent = state.regenerateFrom ? '生成新图纸（原图保留）' : '生成拼豆图纸';
  $('#sheet-generate').setAttribute('aria-hidden', 'false');
}

/* ---------------- 去背景：状态提示 + 遮罩预览 ---------------- */

let previewToken = 0;

function syncBackgroundState() {
  const remove = $('#opt-background').checked;
  $('#background-state').textContent = remove ? '去除' : '保留';
  $('#background-hint').textContent = remove
    ? '纯色底留空不摆豆；下方遮罩里洋红的部分会被去掉'
    : '天空、底色也会排成格子；打开后纯色底留空';
  if (!remove) {
    previewToken += 1;
    $('#mask-preview').hidden = true;
    $('#btn-generate').disabled = false;
  }
}

function drawMaskPreview(preview) {
  const canvas = $('#mask-preview-canvas');
  const ctx = canvas.getContext('2d');
  const size = 120;
  canvas.width = size;
  canvas.height = size;
  ctx.clearRect(0, 0, size, size);
  const scale = Math.min(size / preview.width, size / preview.height);
  const width = Math.round(preview.width * scale);
  const height = Math.round(preview.height * scale);
  const offsetX = Math.round((size - width) / 2);
  const offsetY = Math.round((size - height) / 2);

  const overlay = document.createElement('canvas');
  overlay.width = preview.width;
  overlay.height = preview.height;
  const overlayCtx = overlay.getContext('2d');
  const pixels = overlayCtx.createImageData(preview.width, preview.height);
  for (let i = 0; i < preview.cells.length; i += 1) {
    const share = preview.cells[i];
    if (share <= 0.02) continue;
    const index = i * 4;
    pixels.data[index] = 233;
    pixels.data[index + 1] = 60;
    pixels.data[index + 2] = 122;
    pixels.data[index + 3] = Math.round(255 * Math.min(0.85, share));
  }
  overlayCtx.putImageData(pixels, 0, 0);

  ctx.fillStyle = '#fff';
  ctx.fillRect(offsetX, offsetY, width, height);
  if (state.pending) ctx.drawImage(state.pending.image, offsetX, offsetY, width, height);
  ctx.drawImage(overlay, offsetX, offsetY, width, height);
}

async function refreshBackgroundPreview() {
  if (!state.pending) return;
  const token = ++previewToken;
  $('#mask-preview').hidden = false;
  $('#mask-preview-title').textContent = '正在分析背景…';
  $('#mask-preview-hint').textContent = '洋红区域会被去掉，确认无误再点生成';
  $('#btn-generate').disabled = true;
  await nextFrame();
  try {
    const source = prepareSource(state.pending.image);
    const preview = backgroundPreview(source, { tolerance: 44 });
    if (token !== previewToken) return;
    drawMaskPreview(preview);
    $('#mask-preview-title').textContent = `预览：${Math.round(preview.ratio * 100)}% 的像素会被去掉`;
  } catch (error) {
    if (token !== previewToken) return;
    $('#mask-preview-title').textContent = '背景分析失败，仍可直接生成';
    console.warn('背景预览失败', error);
  } finally {
    if (token === previewToken) $('#btn-generate').disabled = false;
  }
}

$('#opt-background').addEventListener('change', () => {
  syncBackgroundState();
  if ($('#opt-background').checked) refreshBackgroundPreview();
});

function closeGenerateSheet() {
  $('#sheet-generate').setAttribute('aria-hidden', 'true');
}

$('#sheet-generate').addEventListener('click', (event) => {
  if (event.target.closest('[data-close]')) closeGenerateSheet();
});

function setSegmented(selector, value) {
  $$(`${selector} button`).forEach((button) => button.classList.toggle('active', button.dataset.value === String(value)));
}

$$('.segmented').forEach((group) => {
  group.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    $$(`#${group.id} button`).forEach((item) => item.classList.toggle('active', item === button));
  });
});

function syncRangeLabels() {
  const width = Number($('#opt-width').value);
  const colors = Number($('#opt-colors').value);
  const speckle = Number($('#opt-speckle').value);
  $('#width-value').textContent = width;
  $('#colors-value').textContent = colors;
  $('#speckle-value').textContent = speckle;
  const image = state.pending && state.pending.image;
  if (image) {
    const height = Math.max(1, Math.round((image.naturalHeight / image.naturalWidth) * width));
    $('#size-hint').textContent = `约 ${width} × ${height} 格 · ${width * height} 颗上限`;
  }
}

['#opt-width', '#opt-colors', '#opt-speckle'].forEach((selector) => {
  $(selector).addEventListener('input', syncRangeLabels);
});

/* ---------------- 裁剪 / 旋转 ---------------- */

$('#btn-crop').addEventListener('click', () => {
  if (!state.pending) return;
  closeGenerateSheet();
  if (!state.cropTool) {
    state.cropTool = new CropTool({ stage: $('#crop-stage'), canvas: $('#crop-canvas'), frame: $('#crop-frame') });
  }
  $('#sheet-crop').setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    state.cropTool.resize();
    state.cropTool.open(state.pending.image);
  });
});

$('#sheet-crop').addEventListener('click', (event) => {
  if (event.target.closest('[data-close]')) {
    $('#sheet-crop').setAttribute('aria-hidden', 'true');
    openGenerateSheet();
  }
});

$('#crop-aspect').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  $$('#crop-aspect button').forEach((item) => item.classList.toggle('active', item === button));
  state.cropTool && state.cropTool.setAspect(button.dataset.value);
});

$('#btn-crop-rotate').addEventListener('click', () => state.cropTool && state.cropTool.rotate());
$('#btn-crop-reset').addEventListener('click', () => state.cropTool && state.cropTool.reset());

$('#btn-crop-apply').addEventListener('click', async () => {
  if (!state.cropTool) return;
  const canvas = state.cropTool.apply();
  if (!canvas) return;
  try {
    const image = await loadImage(canvas.toDataURL('image/png'));
    const name = state.pending ? state.pending.name : '拼豆图纸';
    releasePending();
    state.pending = { image, url: image.src, name };
    $('#sheet-crop').setAttribute('aria-hidden', 'true');
    openGenerateSheet();
  } catch {
    toast('取景失败，请重试或换一张图', { error: true });
  }
});

/* ---------------- 生成 ---------------- */

$('#btn-generate').addEventListener('click', async () => {
  if (!state.pending) return;
  const settings = {
    width: Number($('#opt-width').value),
    colors: Number($('#opt-colors').value),
    brand: $('#opt-brand button.active').dataset.value,
    style: $('#opt-style button.active').dataset.value,
    background: $('#opt-background').checked,
    speckle: Number($('#opt-speckle').value),
  };
  state.lastSettings = settings;

  setLoading(true, '正在分析图片并匹配色号…');
  await nextFrame();
  try {
    const source = prepareSource(state.pending.image);
    const options = {
      width: settings.width,
      maxColors: settings.colors,
      brand: settings.brand,
      generationStyle: settings.style,
      backgroundMode: settings.background ? 'remove-white' : 'keep',
      tolerance: 44,
      speckleReduction: settings.speckle,
    };
    const result = await convertAsync(source, options).catch(async (error) => {
      console.warn('Worker 生成失败，回退主线程', error);
      await nextFrame();
      return convertToBeads(source, options);
    });
    const project = buildProject(result, settings);
    saveProject(project);
    closeGenerateSheet();
    releasePending();
    state.regenerateFrom = null;
    setLoading(false);
    toast(`生成完成：${result.totalBeads} 颗 · ${result.colorsUsed} 色`);
    openProject(project.id);
  } catch (error) {
    console.error(error);
    setLoading(false);
    toast('生成失败：图片可能过大，调低宽度后重试', { error: true, duration: 3200 });
  }
});

function buildProject(result, settings) {
  const pending = state.pending || {};
  const project = {
    id: `p${Date.now().toString(36)}`,
    name: pending.name || '拼豆图纸',
    createdAt: new Date().toISOString(),
    width: result.width,
    height: result.height,
    brand: settings.brand,
    brandLabel: brandLabels[settings.brand],
    cells: result.cells,
    totalBeads: result.totalBeads,
    colorsUsed: result.colorsUsed,
    done: new Uint8Array(result.width * result.height),
    doneCount: 0,
    stock: {},
    beadsPerPack: 1000,
    settings: { style: settings.style, maxColors: settings.colors, speckle: settings.speckle },
    // 生成参数快照，重新生成时用来预填面板。
    generateOptions: { ...settings },
  };
  // 重新生成时直接沿用同一份原图，避免二次压缩损失。
  project.sourceThumb = pending.sourceThumb || (pending.image ? makeSourceThumb(pending.image) : null);
  project.sourceImage = pending.sourceImage || (pending.image ? makeSourceImage(pending.image) : null);
  project.thumb = makeThumb(project);
  return project;
}

/** 把原图压成体积可控的数据，用于图纸页对照（目标 20KB 以内）。 */
function makeSourceThumb(image) {
  let edge = 320;
  let quality = 0.7;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const data = encodeJpeg(image, edge, quality);
    if (data.length <= 28000) return data;
    edge = Math.round(edge * 0.8);
    quality = Math.max(0.4, quality - 0.1);
  }
  return encodeJpeg(image, 220, 0.45);
}

/** 保留一份可重新生成的原图（长边 1440），体积尽量压在 850KB 以内。 */
function makeSourceImage(image) {
  let edge = 1440;
  let quality = 0.78;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const data = encodeJpeg(image, edge, quality);
    if (data.length <= 850000) return data;
    edge = Math.round(edge * 0.85);
    quality = Math.max(0.55, quality - 0.1);
  }
  return encodeJpeg(image, 1000, 0.6);
}

function encodeJpeg(image, maxEdge, quality) {
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  const ratio = Math.max(naturalWidth, naturalHeight) > maxEdge ? maxEdge / Math.max(naturalWidth, naturalHeight) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(naturalWidth * ratio));
  canvas.height = Math.max(1, Math.round(naturalHeight * ratio));
  const context = canvas.getContext('2d');
  // 透明 PNG 先铺白底，避免转 JPEG 后变黑。
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/* ---------------- 项目页 ---------------- */

const LAST_PROJECT_KEY = 'pindou.lastProject';

function openProject(id) {
  const project = getProject(id);
  if (!project) {
    toast('图纸不存在，可能已被清理', { error: true });
    goHome();
    return;
  }
  localStorage.setItem(LAST_PROJECT_KEY, id);
  state.project = project;
  state.filter = null;
  state.paint = null;
  state.stroke = null;
  state.strokeDone = null;
  state.markTarget = null;
  state.history.clear();
  setTool('view');
  if (location.hash !== `#p=${id}`) history.pushState(null, '', `#p=${id}`);
  $('#view-home').classList.add('hidden');
  $('#view-project').classList.remove('hidden');
  $('#project-title').textContent = project.name;
  $('#project-name').value = project.name;
  $('#project-pack').value = project.beadsPerPack || 1000;
  $('#settings-size').textContent = `${project.width} × ${project.height} 格`;
  $('#settings-brand').textContent = project.brandLabel || brandLabels[project.brand] || project.brand;
  $('#settings-created').textContent = new Date(project.createdAt).toLocaleDateString('zh-CN');
  syncCalibrationUI();

  if (!state.viewer) {
    state.viewer = new BoardViewer($('#board'), {
      onTapCell: handleTapCell,
      onStroke: handleStroke,
      onLongPressStart: handleLongPressStart,
      onLongPressMove: handleLongPressMove,
      onLongPressEnd: handleLongPressEnd,
      onViewChange: (label) => {
        $('#zoom-badge').textContent = label;
      },
    });
  }
  state.viewer.setEditTool('view');
  state.viewer.setPaintColor(null);
  state.viewer.setProject(project);
  state.viewer.setFilter(null);
  state.viewer.start();
  setupCompare(project);
  $('#regenerate-group').classList.toggle('hidden', !project.sourceImage);

  switchTab('board');
  renderAll();
  requestAnimationFrame(() => {
    state.viewer.resize();
    state.viewer.fit();
    state.viewer.invalidate();
  });
}

function goHome() {
  if (state.saveTimer) flushSave();
  if (state.viewer) state.viewer.stop();
  state.project = null;
  state.compare = { mode: 'off', image: null };
  state.regenerateFrom = null;
  state.paint = null;
  state.strokeDone = null;
  state.markTarget = null;
  state.restoreTool = null;
  state.tempPicked = null;
  state.history.clear();
  setTool('view');
  localStorage.removeItem(LAST_PROJECT_KEY);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  $('#view-project').classList.add('hidden');
  $('#view-home').classList.remove('hidden');
  renderHome();
}

$('#btn-back').addEventListener('click', goHome);

window.addEventListener('popstate', () => {
  const match = location.hash.match(/^#p=(.+)$/);
  if (match) openProject(match[1]);
  else goHome();
});

function renderAll() {
  renderProgress();
  renderColorStrip();
  renderUsage();
}

function switchTab(tab) {
  $$('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  $$('.page').forEach((page) => page.classList.toggle('active', page.dataset.page === tab));
  if (tab === 'board' && state.viewer) {
    requestAnimationFrame(() => {
      state.viewer.resize();
      state.viewer.invalidate();
      updateColorStripCue();
    });
  }
  if (tab === 'usage') renderUsage();
  if (tab === 'settings') refreshEntitlement();
}

$$('.tab').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));

/* ---------------- 工具与逐格编辑 ---------------- */

const TOOL_LABELS = { view: '浏览', mark: '勾选', brush: '画笔', eraser: '橡皮', picker: '吸管', bucket: '填充' };

/** 只切换高亮，不触发取色/筛选等副作用。 */
function updateToolButtons() {
  $$('#tool-row [data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === state.tool));
}

function setTool(tool) {
  state.tool = tool;
  updateToolButtons();
  if (state.viewer) state.viewer.setPainting(EDIT_TOOLS.includes(tool));
  if (tool === 'brush' || tool === 'bucket') ensurePaintColor();
  if (state.viewer) {
    state.viewer.setEditTool(tool);
    state.viewer.setPaintColor(state.paint);
  }
  applyViewerFilter();
  renderToolHint();
  renderProgress();
  renderColorStrip();
}

$('#tool-row').addEventListener('click', (event) => {
  const button = event.target.closest('[data-tool]');
  if (button) {
    hideToast();
    setTool(button.dataset.tool);
  }
});

/** 筛选只用于浏览/勾选的「只看某色」，画笔/橡皮/填充/吸管都不压暗画布。 */
function applyViewerFilter() {
  if (!state.viewer) return;
  const isolate = state.tool === 'view' || state.tool === 'mark';
  state.viewer.setFilter(isolate ? state.filter : null);
  state.viewer.invalidate();
}

/** 画笔颜色：优先沿用当前筛选色，否则取用量最高的颜色。 */
function ensurePaintColor() {
  if (state.paint && getColor(state.paint)) return;
  if (state.filter && getColor(state.filter)) {
    state.paint = state.filter;
    return;
  }
  const usage = state.project ? computeUsage(state.project) : null;
  const first = usage && usage.rows[0];
  if (first) state.paint = first.id;
  else toast('这张图纸还没有颜色', { error: true });
}

function setPaint(colorId) {
  state.paint = colorId || null;
  if (state.viewer) state.viewer.setPaintColor(state.paint);
  renderToolHint();
  renderColorStrip();
}

function setFilter(colorId) {
  state.filter = colorId || null;
  applyViewerFilter();
  renderProgress();
  renderColorStrip();
}

/** 工具提示带上当前色号，避免「不知道画笔用的是什么颜色」。 */
function renderToolHint() {
  const base = TOOL_HINTS[state.tool] || '';
  const color = (state.tool === 'brush' || state.tool === 'bucket' || state.tool === 'picker') && state.paint
    ? getColor(state.paint)
    : null;
  const hint = $('#tool-hint');
  if (color) {
    hint.innerHTML = `<i class="hint-swatch" style="background:${color.hex}"></i>${escapeHtml(base)} · ${escapeHtml(color.code)}`;
  } else {
    hint.textContent = base;
  }
}

function handleStroke(phase, index) {
  const project = state.project;
  if (!project) return;

  if (phase === 'start') {
    hideToast();
    state.stroke = new Map();
    state.strokeDone = new Map();
    state.markTarget = null;
  }

  if (state.tool === 'mark') {
    // 起手决定是「补齐」还是「取消」：在同一笔里保持一致，避免来回横跳。
    if (phase === 'start') state.markTarget = project.done[index] ? 0 : 1;
    const change = doneChange(project, index, state.markTarget);
    if (change) {
      project.done[index] = change.to;
      if (state.strokeDone) state.strokeDone.set(index, change);
      state.viewer.invalidate();
    }
  } else if (phase === 'start' || phase === 'move') {
    if (state.tool === 'brush' || state.tool === 'eraser') {
      paintCell(index);
      state.viewer.invalidate();
    } else if (state.tool === 'picker') {
      pickColor(index, phase === 'move');
    } else if (state.tool === 'bucket' && phase === 'start') {
      bucketFill(index);
      state.viewer.invalidate();
    }
  }

  if (phase === 'end') {
    const cells = state.stroke ? [...state.stroke.values()] : [];
    const done = state.strokeDone ? [...state.strokeDone.values()] : [];
    state.stroke = null;
    state.strokeDone = null;
    state.markTarget = null;
    if (cells.length || done.length) {
      state.history.push({ cells, done });
      refreshAfterEdit({ thumb: state.tool !== 'mark' });
      if (state.tool === 'bucket') toast(`已填充 ${cells.length} 颗 · 可撤销`);
    } else if (state.tool === 'brush') {
      toast('这些格子已经是当前色了，可在下方换色');
    } else if (state.tool === 'eraser') {
      toast('这些格子已经是空的');
    }
  }
}

function paintCell(index) {
  const project = state.project;
  const to = state.tool === 'eraser' ? null : state.paint;
  if (!to && state.tool === 'brush') return;
  const change = cellChange(project, index, to);
  if (!change) return;
  project.cells[index] = to;
  if (state.stroke) state.stroke.set(index, change);
}

/** 吸管：取色后停留在吸管工具，方便连续吸多个颜色；长按临时吸管则由松手流程恢复工具。 */
function pickColor(index, quiet = false) {
  const id = state.project.cells[index];
  if (!id) {
    if (!quiet) toast('这个位置没有豆子');
    return null;
  }
  const color = getColor(id);
  state.paint = id;
  renderToolHint();
  renderColorStrip();
  if (!quiet) toast(`已吸取 ${color ? color.code : ''} · 可继续点其它格`);
  return id;
}

function bucketFill(index) {
  const project = state.project;
  const to = state.paint;
  if (!to) return;
  const target = project.cells[index] || null;
  if (target === to) {
    toast('这片区域已经是当前色了');
    return;
  }
  const stack = [index];
  const seen = new Set();
  const width = project.width;
  const height = project.height;
  while (stack.length) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    if ((project.cells[current] || null) !== target) continue;
    const change = cellChange(project, current, to);
    if (change) {
      project.cells[current] = to;
      if (state.stroke) state.stroke.set(current, change);
    }
    const x = current % width;
    const y = Math.floor(current / width);
    if (x > 0) stack.push(current - 1);
    if (x < width - 1) stack.push(current + 1);
    if (y > 0) stack.push(current - width);
    if (y < height - 1) stack.push(current + width);
  }
}

/* ---------------- 长按临时吸管 ---------------- */

function handleLongPressStart(index) {
  if (state.tool === 'picker') return;
  state.restoreTool = state.tool;
  state.tempPicked = null;
  setTool('picker');
  const id = state.project.cells[index];
  if (id) {
    state.tempPicked = id;
    state.paint = id;
    renderColorStrip();
    const color = getColor(id);
    $('#tool-hint').textContent = `吸管（临时）· 已吸取 ${color ? color.code : ''}，松手返回${TOOL_LABELS[state.restoreTool] || ''}`;
  } else {
    $('#tool-hint').textContent = '吸管（临时）· 移到有豆的格子';
  }
}

function handleLongPressMove(index) {
  const id = state.project.cells[index];
  if (!id) return;
  state.tempPicked = id;
  state.paint = id;
  renderColorStrip();
  const color = getColor(id);
  $('#tool-hint').textContent = `吸管（临时）· 已吸取 ${color ? color.code : ''}，松手返回${TOOL_LABELS[state.restoreTool] || ''}`;
}

function handleLongPressEnd() {
  const restore = state.restoreTool;
  state.restoreTool = null;
  if (!restore) return;
  const picked = state.tempPicked;
  state.tempPicked = null;
  // 勾选模式吸色后直接只看这一色；浏览模式仅在原本就在筛选时跟随切换。
  if (picked && (restore === 'mark' || (restore === 'view' && state.filter))) state.filter = picked;
  setTool(restore);
  if (picked) {
    const color = getColor(picked);
    toast(`已吸取 ${color ? color.code : ''} · 已回到${TOOL_LABELS[restore] || ''}`);
  }
}

function handleTapCell() {
  // 浏览模式单击不再弹「先切到勾选」：勾选已支持点按/拖动，浏览模式点按保持安静。
}

/** 编辑后统一刷新：统计、用量、筛选、缩略图、落盘。 */
function refreshAfterEdit({ thumb = true } = {}) {
  const project = state.project;
  if (!project) return;
  const cleared = [];
  if (state.filter && !getColor(state.filter)) {
    state.filter = null;
    cleared.push('filter');
  }
  if (state.paint && !getColor(state.paint)) {
    state.paint = null;
    cleared.push('paint');
  }
  if (cleared.length) {
    applyViewerFilter();
    renderToolHint();
  }
  let total = 0;
  const used = new Set();
  project.cells.forEach((id) => {
    if (!id) return;
    total += 1;
    used.add(id);
  });
  project.totalBeads = total;
  project.colorsUsed = used.size;
  state.viewer.invalidate();
  renderProgress();
  renderColorStrip();
  renderUsage();
  if (thumb) project.thumb = makeThumb(project);
  scheduleSave();
}

/* ---------------- 撤销 / 重做 ---------------- */

state.history.onChange = ({ canUndo, canRedo }) => {
  $('#btn-undo').disabled = !canUndo;
  $('#btn-redo').disabled = !canRedo;
};

$('#btn-undo').addEventListener('click', () => {
  if (!state.project) return;
  const record = state.history.undo(state.project);
  if (!record) {
    toast('没有可撤销的操作');
    return;
  }
  refreshAfterEdit();
  toast('已撤销');
});

$('#btn-redo').addEventListener('click', () => {
  if (!state.project) return;
  const record = state.history.redo(state.project);
  if (!record) {
    toast('没有可重做的操作');
    return;
  }
  refreshAfterEdit();
  toast('已重做');
});

/* ---------------- 缩放 / 显示开关 ---------------- */

$('#btn-zoom-in').addEventListener('click', () => state.viewer && state.viewer.zoomAt(1.35));
$('#btn-zoom-out').addEventListener('click', () => state.viewer && state.viewer.zoomAt(1 / 1.35));
$('#btn-fit').addEventListener('click', () => {
  if (!state.viewer) return;
  state.viewer.fit();
  state.viewer.invalidate();
});

$('#btn-grid').addEventListener('click', () => {
  const active = $('#btn-grid').classList.toggle('active');
  state.viewer && state.viewer.setOptions({ showGrid: active });
});
$('#btn-codes').addEventListener('click', () => {
  const active = $('#btn-codes').classList.toggle('active');
  state.viewer && state.viewer.setOptions({ showCodes: active });
  if (active) toast('放大到格子足够大时显示色号');
});
$('#btn-bead').addEventListener('click', () => {
  const active = $('#btn-bead').classList.toggle('active');
  state.viewer && state.viewer.setOptions({ beadStyle: active });
});

/* ---------------- 对比原图 ---------------- */

/** 老项目没有保存原图，直接隐藏入口。 */
function setupCompare(project) {
  state.compare = { mode: 'off', image: null };
  if (state.viewer) state.viewer.setCompare(null, 'off');
  const button = $('#btn-compare');
  const available = Boolean(project && project.sourceThumb);
  button.classList.toggle('hidden', !available);
  button.classList.remove('active');
  button.textContent = '对比';
}

$('#btn-compare').addEventListener('click', () => {
  const project = state.project;
  if (!project || !project.sourceThumb || !state.viewer) return;
  const modes = ['overlay', 'split', 'off'];
  const next = modes[(modes.indexOf(state.compare.mode) + 1) % modes.length];
  const button = $('#btn-compare');

  if (next === 'off') {
    state.compare.mode = 'off';
    state.viewer.setCompare(null, 'off');
    button.classList.remove('active');
    button.textContent = '对比';
    return;
  }

  if (!state.compare.image) {
    const image = new Image();
    image.onload = () => state.viewer && state.viewer.invalidate();
    image.src = project.sourceThumb;
    state.compare.image = image;
  }
  state.compare.mode = next;
  state.viewer.setCompare(state.compare.image, next);
  button.classList.add('active');
  button.textContent = next === 'overlay' ? '叠加' : '左右';
  toast(next === 'overlay' ? '原图半透明叠加，再点一次切到左右对照' : '左半原图 / 右半图纸，再点一次关闭');
});

/* ---------------- 进度 / 颜色条 ---------------- */

function renderProgress() {
  const project = state.project;
  if (!project) return;
  const { done, total, percent } = progressOf(project);
  $('#progress-text').textContent = `${done} / ${total} 颗`;
  $('#progress-percent').textContent = `${percent}%`;
  $('#progress-fill').style.width = `${percent}%`;
  const isolate = Boolean(state.filter) && (state.tool === 'view' || state.tool === 'mark');
  if (isolate) {
    const color = getColor(state.filter);
    const remaining = countRemaining(state.filter);
    $('#filter-status').textContent = color ? `只看 ${color.code} · 还剩 ${remaining} 颗` : '';
  } else {
    $('#filter-status').textContent = '';
  }
}

function remainingByColor() {
  const project = state.project;
  const map = new Map();
  project.cells.forEach((id, index) => {
    if (!id) return;
    const row = map.get(id) || { total: 0, remaining: 0 };
    row.total += 1;
    if (!project.done[index]) row.remaining += 1;
    map.set(id, row);
  });
  return map;
}

function countRemaining(colorId) {
  const project = state.project;
  let remaining = 0;
  project.cells.forEach((id, index) => {
    if (id === colorId && !project.done[index]) remaining += 1;
  });
  return remaining;
}

function renderColorStrip() {
  const project = state.project;
  if (!project) return;
  const usage = computeUsage(project);
  const remainingMap = remainingByColor();
  const rows = usage.rows.slice().sort((a, b) => b.count - a.count);
  const isolate = state.tool === 'view' || state.tool === 'mark';
  const activeId = isolate ? state.filter : state.paint;
  $('#color-strip').innerHTML = rows
    .map((row) => {
      const remaining = remainingMap.get(row.id)?.remaining ?? 0;
      const classes = ['color-chip'];
      if (activeId === row.id) classes.push('active');
      if (remaining === 0) classes.push('done');
      return `
        <button class="${classes.join(' ')}" data-color="${row.id}">
          <span class="swatch" style="background:${row.color.hex}"></span>
          <span class="code">${escapeHtml(row.color.code)}</span>
          ${remaining > 0 ? `<span class="left">${remaining}</span>` : ''}
        </button>`;
    })
    .join('');

  const bar = $('#filter-bar');
  bar.classList.toggle('hidden', !(isolate && state.filter));
  if (isolate && state.filter) {
    const color = getColor(state.filter);
    $('#filter-label').textContent = color ? `${color.code} · ${brandLabels[color.brand] || ''}` : '';
  }

  $('#color-strip-count').textContent = rows.length > 0 ? `颜色 ${rows.length} 种` : '还没有需要摆的豆';
  requestAnimationFrame(updateColorStripCue);
}

/** 色条放不下时给出“可左右滑动”的提示和右侧渐隐，避免看起来像颜色缺失。 */
function updateColorStripCue() {
  const strip = $('#color-strip');
  const hint = $('#color-strip-hint');
  if (!strip || !hint) return;
  const overflow = strip.scrollWidth - strip.clientWidth > 4;
  hint.classList.toggle('hidden', !overflow);
  strip.classList.toggle('scrollable', overflow);
  strip.classList.toggle('at-end', !overflow || strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 6);
}

$('#color-strip').addEventListener('scroll', updateColorStripCue, { passive: true });
window.addEventListener('resize', () => requestAnimationFrame(updateColorStripCue));
window.addEventListener('orientationchange', () => setTimeout(updateColorStripCue, 260));

$('#color-strip').addEventListener('click', (event) => {
  const chip = event.target.closest('.color-chip');
  if (!chip) return;
  hideToast();
  const id = chip.dataset.color;
  const isolate = state.tool === 'view' || state.tool === 'mark';
  if (isolate) {
    // 浏览/勾选：点色卡是「只看这一色」，再次点击取消筛选。
    const next = state.filter === id ? null : id;
    if (next) state.paint = next;
    setFilter(next);
  } else {
    // 画笔/橡皮/填充/吸管：点色卡只切换当前用色，不会把颜色取消掉。
    setPaint(id);
  }
});

$('#btn-clear-filter').addEventListener('click', () => setFilter(null));

$('#btn-color-prev').addEventListener('click', () => stepFilter(-1));
$('#btn-color-next').addEventListener('click', () => stepFilter(1));

/** 逐色模式：按用量顺序在颜色之间切换，一次只高亮一种。 */
function stepFilter(step) {
  const project = state.project;
  if (!project) return;
  const rows = computeUsage(project).rows;
  if (!rows.length) return;
  const current = rows.findIndex((row) => row.id === state.filter);
  const next = current < 0 ? 0 : (current + step + rows.length) % rows.length;
  setFilter(rows[next].id);
}

$('#btn-fill-color').addEventListener('click', () => {
  const project = state.project;
  if (!project || !state.filter) return;
  const changes = [];
  project.cells.forEach((id, index) => {
    if (id !== state.filter) return;
    const change = doneChange(project, index, 1);
    if (!change) return;
    project.done[index] = 1;
    changes.push(change);
  });
  if (!changes.length) {
    toast('这一色已经拼完了');
    return;
  }
  state.history.push({ done: changes });
  state.viewer.invalidate();
  refreshAfterEdit({ thumb: false });
  toast(`已标记 ${changes.length} 颗`);
});

/* ---------------- 整色替换 ---------------- */

$('#btn-replace').addEventListener('click', () => {
  if (!state.project) return;
  let from = state.filter || state.paint;
  if (!from) {
    const rows = computeUsage(state.project).rows;
    if (!rows.length) {
      toast('这张图纸还没有颜色', { error: true });
      return;
    }
    from = rows[0].id;
  }
  state.replaceFrom = from;
  state.replaceTo = null;
  renderReplaceGrid();
  $('#sheet-replace').setAttribute('aria-hidden', 'false');
});

$('#sheet-replace').addEventListener('click', (event) => {
  if (event.target.closest('[data-close]')) $('#sheet-replace').setAttribute('aria-hidden', 'true');
});

function replaceChip(row, active, attr) {
  const disabled = attr === 'data-target' && row.disabled;
  return `
    <button class="replace-chip${active ? ' active' : ''}" ${attr}="${row.id}" ${disabled ? 'disabled' : ''}>
      <span class="swatch" style="background:${row.color.hex}"></span>
      <span class="code">${escapeHtml(row.color.code)}</span>
      <span class="count">${row.count}</span>
    </button>`;
}

function renderReplaceGrid() {
  const project = state.project;
  if (!project) return;
  const usage = computeUsage(project);
  if (!usage.rows.length) {
    state.replaceFrom = null;
    state.replaceTo = null;
    $('#replace-source').innerHTML = '';
    $('#replace-grid').innerHTML = '<div class="replace-empty">这张图纸还没有颜色。</div>';
    $('#replace-hint').textContent = '先给图纸涂上颜色，再整色替换。';
    $('#btn-replace-apply').disabled = true;
    $('#btn-replace-apply').textContent = '确认替换';
    return;
  }
  if (!state.replaceFrom || !usage.rows.some((row) => row.id === state.replaceFrom)) {
    state.replaceFrom = usage.rows[0].id;
  }
  const source = usage.rows.find((row) => row.id === state.replaceFrom);
  const targets = usage.rows.filter((row) => row.id !== state.replaceFrom);
  if (state.replaceTo && !targets.some((row) => row.id === state.replaceTo)) state.replaceTo = null;
  const target = state.replaceTo ? usage.rows.find((row) => row.id === state.replaceTo) : null;

  $('#replace-source').innerHTML = usage.rows
    .map((row) => replaceChip(row, row.id === state.replaceFrom, 'data-source'))
    .join('');
  $('#replace-grid').innerHTML = targets.length
    ? targets
        .map((row) => replaceChip({ ...row, disabled: row.id === state.replaceFrom }, row.id === state.replaceTo, 'data-target'))
        .join('')
    : '<div class="replace-empty">只有一种颜色，暂时没有可替换的目标。</div>';

  $('#replace-hint').textContent = source
    ? target
      ? `将把 ${source.count} 颗 ${source.color.code} 换成 ${target.color.code}，执行后可撤销。`
      : `源色 ${source.color.code} 共 ${source.count} 颗，请选择目标颜色。`
    : '先选要替换掉的源颜色，再选目标颜色。';

  const button = $('#btn-replace-apply');
  button.disabled = !state.replaceTo;
  button.textContent = source && target ? `把 ${source.color.code} 全部换成 ${target.color.code}（${source.count} 颗）` : '确认替换';
}

$('#replace-source').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-source]');
  if (!chip) return;
  state.replaceFrom = chip.dataset.source;
  state.replaceTo = null;
  renderReplaceGrid();
});

$('#replace-grid').addEventListener('click', (event) => {
  const chip = event.target.closest('.replace-chip');
  if (!chip || chip.disabled) return;
  state.replaceTo = chip.dataset.target;
  renderReplaceGrid();
});

$('#btn-replace-apply').addEventListener('click', () => {
  const project = state.project;
  if (!project || !state.replaceFrom || !state.replaceTo) return;
  const from = state.replaceFrom;
  const to = state.replaceTo;
  const changes = [];
  project.cells.forEach((id, index) => {
    if (id !== from) return;
    const change = cellChange(project, index, to);
    if (!change) return;
    project.cells[index] = to;
    changes.push(change);
  });
  if (!changes.length) {
    toast('没有需要替换的格子');
    return;
  }
  state.history.push({ cells: changes });
  // 替换后源色通常不再使用：不再继续「只看源色」，画笔顺势切到目标色。
  if (state.filter === from) state.filter = null;
  if (state.paint === from) state.paint = to;
  $('#sheet-replace').setAttribute('aria-hidden', 'true');
  applyViewerFilter();
  if (state.viewer) state.viewer.setPaintColor(state.paint);
  renderToolHint();
  refreshAfterEdit();
  const fromColor = getColor(from);
  const toColor = getColor(to);
  toast(`已替换 ${changes.length} 颗：${fromColor ? fromColor.code : ''} → ${toColor ? toColor.code : ''}`);
});

/* ---------------- 保存 ---------------- */

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushSave, 500);
}

function flushSave() {
  state.saveTimer = 0;
  if (!state.project) return;
  saveProject(state.project);
}

window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSave();
});

/* ---------------- 用量 ---------------- */

function renderUsage() {
  const project = state.project;
  if (!project) return;
  const usage = computeUsage(project);
  const packs = usage.rows.reduce((sum, row) => sum + row.packs, 0);
  $('#stat-total').textContent = usage.total.toLocaleString('zh-CN');
  $('#stat-colors').textContent = usage.colors;
  $('#stat-packs').textContent = packs;

  const banner = $('#shortage-banner');
  if (!usage.checkedColors) {
    banner.className = 'shortage-banner';
    banner.textContent = '还没登记库存。展开右侧输入框填入手头每种豆的数量，就能算出缺多少。';
  } else if (usage.shortageColors > 0) {
    banner.className = 'shortage-banner warn';
    banner.textContent = `还差 ${usage.shortageColors} 种颜色，建议再补 ${usage.shortageBeads.toLocaleString('zh-CN')} 颗。`;
  } else {
    banner.className = 'shortage-banner';
    banner.textContent = '库存足够，可以直接开工。';
  }

  $('#usage-list').innerHTML = usage.rows.length
    ? usage.rows
        .map((row) => {
          const short = row.shortage !== null && row.shortage > 0;
          return `
        <div class="usage-row ${short ? 'short' : ''}" data-id="${row.id}">
          <span class="usage-swatch" style="background:${row.color.hex}"></span>
          <div class="usage-main">
            <div><span class="usage-code">${escapeHtml(row.color.code)}</span><span class="usage-name">${escapeHtml(brandLabels[row.color.brand] || '')}</span></div>
            <div class="usage-meta">${row.count} 颗 · 建议备货 ${row.suggest} · ≈${row.packs} 包</div>
          </div>
          <div class="usage-stock">
            <input type="number" inputmode="numeric" min="0" placeholder="库存" value="${row.stock ?? ''}" data-stock="${row.id}" />
            <div class="usage-short">${row.shortage !== null ? (short ? `缺 ${row.shortage} 颗` : '已备齐') : ''}</div>
          </div>
        </div>`;
        })
        .join('')
    : '<div class="empty">这张图纸还没有需要摆的豆。<br />可以用画笔涂色，或替换颜色后再来看用量。</div>';
}

$('#usage-list').addEventListener('input', (event) => {
  const input = event.target.closest('[data-stock]');
  if (!input) return;
  const project = state.project;
  if (!project) return;
  const id = input.dataset.stock;
  const value = input.value.trim() === '' ? null : Math.max(0, Math.round(Number(input.value)));
  if (value === null) delete project.stock[id];
  else project.stock[id] = value;

  // 就地更新这一行的缺口文案与汇总，避免重绘导致输入框失焦。
  const usage = computeUsage(project);
  const row = usage.rows.find((item) => item.id === id);
  const rowElement = input.closest('.usage-row');
  if (row && rowElement) {
    const short = row.shortage !== null && row.shortage > 0;
    rowElement.classList.toggle('short', short);
    rowElement.querySelector('.usage-short').textContent =
      row.shortage !== null ? (short ? `缺 ${row.shortage} 颗` : '已备齐') : '';
  }
  const banner = $('#shortage-banner');
  if (usage.shortageColors > 0) {
    banner.className = 'shortage-banner warn';
    banner.textContent = `还差 ${usage.shortageColors} 种颜色，建议再补 ${usage.shortageBeads.toLocaleString('zh-CN')} 颗。`;
  } else if (usage.checkedColors > 0) {
    banner.className = 'shortage-banner';
    banner.textContent = '库存足够，可以直接开工。';
  }
  scheduleSave();
});

/* ---------------- 用原图重新生成 ---------------- */

$('#btn-regenerate').addEventListener('click', () => {
  const project = state.project;
  if (!project) return;
  if (!project.sourceImage) {
    toast('这张图纸没有保存原图，无法重新生成', { error: true });
    return;
  }
  openHelp({
    title: '用原图重新生成',
    html: `
      <p>会用这张图纸的原图重新生成一份新图纸，参数可以重新调整。</p>
      <ul class="help-steps">
        <li>当前图纸和已勾的进度都会保留，不会被覆盖</li>
        <li>新图纸另存为「${escapeHtml(project.name)} · 新版本」</li>
        <li>生成后首页会同时显示两张，对比后再决定留哪张</li>
      </ul>`,
    actionText: '继续调整参数',
    onAction: () => startRegenerate(project),
  });
});

/** 重新生成始终另存为新图纸：旧图纸的勾选进度和库存都是用户投入，覆盖损失最大。 */
function startRegenerate(project) {
  const image = new Image();
  image.onload = () => {
    releasePending();
    state.regenerateFrom = project.id;
    state.pending = {
      image,
      url: project.sourceImage,
      name: `${project.name} · 新版本`,
      sourceThumb: project.sourceThumb || null,
      sourceImage: project.sourceImage,
    };
    // 老图纸里存的是当时的默认值（去背景），重新生成时以当前默认「保留背景」为准，
    // 需要去背景的用户在弹层里手动打开。
    const inherited = { ...(project.generateOptions || {}) };
    delete inherited.background;
    state.lastSettings = { ...state.lastSettings, ...inherited };
    openGenerateSheet();
  };
  image.onerror = () => toast('原图读取失败，请换一张图重新生成', { error: true });
  image.src = project.sourceImage;
}

/* ---------------- 设置 / 打印校准 ---------------- */

$('#project-name').addEventListener('change', (event) => {
  const name = event.target.value.trim() || '拼豆图纸';
  event.target.value = name;
  if (!state.project) return;
  state.project.name = name;
  $('#project-title').textContent = name;
  state.project.thumb = makeThumb(state.project);
  scheduleSave();
});

$('#project-pack').addEventListener('change', (event) => {
  if (!state.project) return;
  const value = Math.max(50, Math.round(Number(event.target.value) || 1000));
  event.target.value = value;
  state.project.beadsPerPack = value;
  renderUsage();
  scheduleSave();
});

function syncCalibrationUI() {
  const calibration = state.calibration;
  const pitch = normalizePitch(calibration.pitch);
  setSegmented('#opt-pitch', pitch);
  setSegmented('#wizard-pitch', pitch);
  const measured = Number(calibration.measured10);
  $('#calib-measured').value = Number.isFinite(measured) && measured > 0 ? measured : '';
  $('#calib-measured').placeholder = String(Math.round(pitch * 100) / 10);
  const cell = resolveCellMm(calibration);
  const corrected = Math.abs(cell - pitch) > 0.01;
  $('#calib-hint').textContent = corrected
    ? `已校正：实际每格 ${cell.toFixed(2)}mm（按实测 ${measured}mm / 10 格）`
    : `按标称 ${pitch}mm 输出；打印校准页后回填实测值可校正打印机缩放。`;
}

['#opt-pitch', '#wizard-pitch'].forEach((selector) => {
  $(selector).addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const pitch = normalizePitch(button.dataset.value);
    if (pitch === normalizePitch(state.calibration.pitch)) return;
    // 换孔距后旧的实测值不再适用，清掉避免按错误比例输出。
    state.calibration = { pitch, measured10: null };
    setSetting('calibration', state.calibration);
    syncCalibrationUI();
    if ($('#sheet-print').getAttribute('aria-hidden') === 'false') {
      updatePrintWizard();
      showPrintStep(1);
    }
  });
});

$('#calib-measured').addEventListener('change', (event) => {
  const pitch = normalizePitch(state.calibration.pitch);
  const raw = event.target.value.trim();
  if (!raw) {
    state.calibration = { ...state.calibration, measured10: null };
    setSetting('calibration', state.calibration);
    syncCalibrationUI();
    toast('已恢复按标称尺寸打印');
    return;
  }
  const value = Number(raw);
  const nominal = pitch * 10;
  if (!Number.isFinite(value) || value < nominal * 0.5 || value > nominal * 2) {
    toast(`实测值应在 ${Math.round(nominal * 0.5)}–${Math.round(nominal * 2)}mm 之间`, { error: true, duration: 3000 });
    syncCalibrationUI();
    return;
  }
  state.calibration = { ...state.calibration, measured10: value };
  setSetting('calibration', state.calibration);
  syncCalibrationUI();
  toast('校准已保存');
});

$('#btn-print-calibration').addEventListener('click', () => {
  toast('正在准备校准页…');
  printCalibration(state.calibration);
});

$('#btn-export').addEventListener('click', () => exportPng());

/* ---------------- 打印向导：先校准，再打印 ---------------- */

function isCalibrated() {
  const measured = Number(state.calibration.measured10);
  return Number.isFinite(measured) && measured > 0;
}

function closePrintWizard() {
  $('#sheet-print').setAttribute('aria-hidden', 'true');
}

function showPrintStep(step) {
  state.printStep = step;
  $('#wizard-page-1').classList.toggle('hidden', step !== 1);
  $('#wizard-page-2').classList.toggle('hidden', step !== 2);
  $('#wizard-dot-1').classList.toggle('active', step === 1);
  $('#wizard-dot-1').classList.toggle('done', step === 2);
  $('#wizard-dot-2').classList.toggle('active', step === 2);
}

function updatePrintWizard() {
  const pitch = normalizePitch(state.calibration.pitch);
  const cell = resolveCellMm(state.calibration);
  const calibrated = isCalibrated();
  const nominal = Math.round(pitch * 100) / 10;
  $('#wizard-calib-status').textContent = calibrated
    ? `已校准：10 格实测 ${state.calibration.measured10}mm，实际每格 ${cell.toFixed(2)}mm。`
    : `当前 ${pitch}mm 孔距，尚未校准。先打印校准页，用尺子量 10 格宽度填进来。`;
  $('#wizard-nominal').textContent = `标称 10 格应量得 ${nominal}mm；实测不同就按实测填。`;
  $('#wizard-measured').value = calibrated ? state.calibration.measured10 : '';
  $('#wizard-measured').placeholder = String(nominal);
  const project = state.project;
  const pages = project ? Math.ceil(project.width / 29) * Math.ceil(project.height / 29) : 0;
  $('#wizard-print-status').textContent = `每格 ${cell.toFixed(2)}mm · A4 每页 29×29 格 · 共 ${pages} 页`;
  $('#wizard-risk').classList.toggle('hidden', calibrated);
  $('#btn-wizard-print').textContent = calibrated ? '开始打印' : '仍然打印（尺寸可能不准）';
}

function openPrintWizard() {
  if (!state.project) return;
  syncCalibrationUI();
  updatePrintWizard();
  // 已校准直接进入打印，未校准从校准步骤开始。
  showPrintStep(isCalibrated() ? 2 : 1);
  $('#sheet-print').setAttribute('aria-hidden', 'false');
}

$('#btn-print').addEventListener('click', openPrintWizard);

$('#sheet-print').addEventListener('click', (event) => {
  if (event.target.closest('[data-close]')) closePrintWizard();
});

$('#btn-wizard-calibration').addEventListener('click', () => {
  toast('正在准备校准页…');
  setTimeout(() => printCalibration(state.calibration), 80);
});

$('#btn-wizard-save').addEventListener('click', () => {
  const pitch = normalizePitch(state.calibration.pitch);
  const raw = $('#wizard-measured').value.trim();
  const value = Number(raw);
  const nominal = pitch * 10;
  if (!raw || !Number.isFinite(value) || value < nominal * 0.5 || value > nominal * 2) {
    toast(`实测值应在 ${Math.round(nominal * 0.5)}–${Math.round(nominal * 2)}mm 之间`, { error: true, duration: 3000 });
    return;
  }
  state.calibration = { ...state.calibration, measured10: value };
  setSetting('calibration', state.calibration);
  syncCalibrationUI();
  updatePrintWizard();
  showPrintStep(2);
  toast('校准已保存，可以打印了');
});

$('#btn-wizard-skip').addEventListener('click', () => {
  updatePrintWizard();
  showPrintStep(2);
  toast('已跳过校准：打印尺寸可能和实物不一致', { error: true, duration: 3000 });
});

$('#btn-wizard-recalibrate').addEventListener('click', () => showPrintStep(1));

$('#btn-wizard-print').addEventListener('click', () => {
  if (!state.project) return;
  if (!requireExport('print')) return;
  closePrintWizard();
  toast(`正在准备 A4 分页（${resolveCellMm(state.calibration).toFixed(2)}mm/格）…`);
  setTimeout(() => printProject(state.project, state.calibration), 120);
});

$('#btn-export-png').addEventListener('click', () => exportPng());
$('#btn-export-csv').addEventListener('click', () => {
  if (!state.project) return;
  if (!requireExport('csv')) return;
  exportUsageCsv(state.project, computeUsage(state.project));
  toast('用量 CSV 已导出');
});

function exportPng() {
  if (!state.project) return;
  if (!requireExport('png')) return;
  toast('正在生成 PNG…');
  setTimeout(() => {
    try {
      exportChart(state.project, computeUsage(state.project));
    } catch (error) {
      console.error(error);
      toast('导出失败：图纸尺寸可能过大', { error: true });
    }
  }, 60);
}

$('#btn-delete').addEventListener('click', () => {
  if (!state.project) return;
  if (!confirm(`确定删除「${state.project.name}」？删除后无法恢复。`)) return;
  deleteProject(state.project.id);
  state.project = null;
  goHome();
  toast('已删除');
});

/* ---------------- 拼装现场：屏幕常亮 ---------------- */

$('#btn-wake').addEventListener('click', async () => {
  const button = $('#btn-wake');
  if (state.wakeLock) {
    try {
      await state.wakeLock.release();
    } catch {
      // 已经释放过
    }
    state.wakeLock = null;
    button.classList.remove('active');
    toast('已关闭屏幕常亮');
    return;
  }
  if (!('wakeLock' in navigator)) {
    toast('当前浏览器不支持屏幕常亮，可临时调高系统自动锁屏时间', { error: true, duration: 3200 });
    return;
  }
  try {
    const lock = await navigator.wakeLock.request('screen');
    state.wakeLock = lock;
    button.classList.add('active');
    lock.addEventListener('release', () => {
      if (state.wakeLock === lock) {
        state.wakeLock = null;
        button.classList.remove('active');
      }
    });
    toast('屏幕常亮已开启，退出页面后自动失效');
  } catch (error) {
    console.warn('Wake Lock 失败', error);
    toast('常亮开启失败：请保持页面在前台，或调高系统锁屏时间', { error: true, duration: 3200 });
  }
});

/* ---------------- 示例图 ---------------- */

async function makeSampleImage() {
  const canvas = document.createElement('canvas');
  canvas.width = 560;
  canvas.height = 560;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 560, 560);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = 14;
  ctx.strokeStyle = '#2a2118';

  // 耳朵
  ctx.fillStyle = '#f2a65a';
  ctx.beginPath();
  ctx.moveTo(148, 214);
  ctx.lineTo(184, 88);
  ctx.lineTo(266, 168);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(412, 214);
  ctx.lineTo(376, 88);
  ctx.lineTo(294, 168);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // 头
  ctx.beginPath();
  ctx.ellipse(280, 300, 168, 150, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#f6b26b';
  ctx.fill();
  ctx.stroke();

  // 眼睛
  ctx.fillStyle = '#241d17';
  [[226, 286], [334, 286]].forEach(([x, y]) => {
    ctx.beginPath();
    ctx.ellipse(x, y, 20, 24, 0, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = '#ffffff';
  [[233, 278], [341, 278]].forEach(([x, y]) => {
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
  });

  // 鼻子 + 嘴
  ctx.fillStyle = '#e8607a';
  ctx.beginPath();
  ctx.moveTo(262, 336);
  ctx.lineTo(298, 336);
  ctx.lineTo(280, 352);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(280, 352);
  ctx.lineTo(280, 366);
  ctx.moveTo(280, 366);
  ctx.quadraticCurveTo(258, 384, 240, 362);
  ctx.moveTo(280, 366);
  ctx.quadraticCurveTo(302, 384, 320, 362);
  ctx.lineWidth = 8;
  ctx.stroke();

  // 胡须
  ctx.beginPath();
  [[196, 320, 118, 302], [196, 342, 116, 344], [364, 320, 442, 302], [364, 342, 444, 344]].forEach(
    ([x1, y1, x2, y2]) => {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    },
  );
  ctx.lineWidth = 6;
  ctx.stroke();

  // 腮红
  ctx.fillStyle = 'rgba(244, 143, 155, 0.75)';
  [[196, 352], [364, 352]].forEach(([x, y]) => {
    ctx.beginPath();
    ctx.ellipse(x, y, 26, 16, 0, 0, Math.PI * 2);
    ctx.fill();
  });

  const image = new Image();
  await new Promise((resolve) => {
    image.onload = resolve;
    image.src = canvas.toDataURL('image/png');
  });
  return image;
}

/* ---------------- 启动 ---------------- */

function syncStorageNote() {
  const mode = state.storage.mode === 'indexeddb' ? 'IndexedDB' : 'localStorage（回退）';
  $('#settings-storage').textContent = `${mode} · 数据 v${state.storage.version}`;
}

async function bootstrap() {
  const info = await initStore();
  state.storage = info;
  state.calibration = getSetting('calibration', { pitch: 5, measured10: null });
  if (info.notice) toast(info.notice, { error: true, duration: 4000 });
  if (info.migratedCount) setTimeout(() => toast(`已迁移 ${info.migratedCount} 张旧图纸到 IndexedDB`), 1400);
  onStoreError(() => toast('保存失败：存储空间可能已满，请清理旧图纸', { error: true, duration: 3200 }));

  renderHome();
  syncStorageNote();
  const initial = location.hash.match(/^#p=(.+)$/) || [null, localStorage.getItem(LAST_PROJECT_KEY)];
  if (initial && initial[1]) openProject(initial[1]);

  initInstall({ showHelp: openHelp, toast });
  initEntitlement({ toast });
  bindPcLink(() => state.project);

  // 从电脑端跳转过来：两端图纸格式不同，不自动带入，只提示一下。
  const params = new URLSearchParams(location.search);
  if (params.get('from') === 'pc') {
    const name = params.get('name');
    const size = params.get('w') && params.get('h') ? `${params.get('w')}×${params.get('h')}` : '';
    setTimeout(
      () =>
        toast(
          `已从电脑端跳转${name ? `（${name}${size ? ` · ${size}` : ''}）` : ''}：两端图纸格式不同，未自动带入，可在这里重新选图生成。`,
          { duration: 5200 },
        ),
      700,
    );
  }
}

bootstrap();

// 便于调试与自动化验收：只暴露只读状态引用。
window.__pindou = state;
