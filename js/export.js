// 导出：带色号/坐标/图例的图纸 PNG，以及用量 CSV。
import { getColor } from './palette.js';

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function safeName(name) {
  return (name || '拼豆图纸').replace(/[\\/:*?"<>|]/g, '-').slice(0, 40);
}

function contrastText([r, g, b]) {
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1b1e24' : '#ffffff';
}

const MAX_EXPORT_SIDE = 12000;
// iOS Safari 画布面积上限约 16.7M 像素，超过会得到空白图。
const MAX_EXPORT_AREA = 16000000;

function baseCell(width) {
  return width > 90 ? 22 : width > 60 ? 26 : 30;
}

/**
 * 导出布局（纯函数，不碰 DOM，bench 可直接断言）。
 * 关键：宽、高只允许用同一个缩放因子收缩，绝不分别截断——否则长图会被裁掉底部和图例。
 */
export function chartLayout(project, usage) {
  const rows = usage && usage.rows ? usage.rows.length : 0;
  const marginLeft = 46;
  const marginTop = 96;
  const marginRight = 26;
  const base = baseCell(project.width);

  const build = (cell) => {
    const gridWidth = project.width * cell;
    const gridHeight = project.height * cell;
    const legendColumns = Math.max(1, Math.min(4, Math.floor(gridWidth / 230)));
    const legendRows = Math.max(1, Math.ceil(rows / legendColumns));
    const legendTop = marginTop + gridHeight + 34;
    const legendHeight = 26 + legendRows * 26 + 28;
    return {
      cell,
      scale: cell / base,
      marginLeft,
      marginTop,
      marginRight,
      gridWidth,
      gridHeight,
      legendColumns,
      legendRows,
      legendTop,
      legendHeight,
      canvasWidth: marginLeft + gridWidth + marginRight,
      canvasHeight: legendTop + legendHeight,
    };
  };

  let layout = build(base);
  let factor = 1;
  // 图例列数随格子宽度变化，迭代几次让「缩放因子 → 图例高度 → 画布高度」收敛。
  for (let i = 0; i < 4; i += 1) {
    const limit = Math.min(
      1,
      MAX_EXPORT_SIDE / Math.max(layout.canvasWidth, layout.canvasHeight),
      Math.sqrt(MAX_EXPORT_AREA / (layout.canvasWidth * layout.canvasHeight)),
    );
    if (limit >= 1) break;
    factor *= limit;
    layout = build(Math.max(1, Math.floor(base * factor)));
  }
  return layout;
}

export function exportChart(project, usage) {
  const layout = chartLayout(project, usage);
  const { cell, marginLeft, marginTop, gridWidth, gridHeight, legendColumns, legendRows, legendTop } = layout;
  const canvas = document.createElement('canvas');
  canvas.width = layout.canvasWidth;
  canvas.height = layout.canvasHeight;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 标题
  ctx.fillStyle = '#161a20';
  ctx.font = '600 24px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(project.name || '拼豆图纸', marginLeft, 44);
  ctx.font = '13px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
  ctx.fillStyle = '#6b7280';
  ctx.fillText(
    `${project.width} × ${project.height} 格 · ${usage.colors} 色 · 共 ${usage.total} 颗 · ${project.brandLabel || project.brand}`,
    marginLeft,
    68,
  );

  // 坐标刻度
  ctx.fillStyle = '#9aa3ad';
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (let x = 0; x < project.width; x += 5) {
    ctx.fillText(String(x + 1), marginLeft + x * cell + cell / 2, marginTop - 8);
  }
  ctx.textAlign = 'right';
  for (let y = 0; y < project.height; y += 5) {
    ctx.fillText(String(y + 1), marginLeft - 10, marginTop + y * cell + cell / 2 + 4);
  }

  // 格子
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let y = 0; y < project.height; y += 1) {
    for (let x = 0; x < project.width; x += 1) {
      const id = project.cells[y * project.width + x];
      if (!id) continue;
      const color = getColor(id);
      if (!color) continue;
      const px = marginLeft + x * cell;
      const py = marginTop + y * cell;
      ctx.fillStyle = color.hex;
      ctx.fillRect(px, py, cell, cell);
      if (cell >= 22) {
        ctx.fillStyle = contrastText(color.rgb);
        ctx.font = `600 ${Math.min(10, cell * 0.4)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillText(color.code, px + cell / 2, py + cell / 2 + 0.5);
      }
    }
  }

  // 网格
  ctx.strokeStyle = 'rgba(0,0,0,0.13)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= project.width; x += 1) {
    const px = marginLeft + x * cell + 0.5;
    ctx.moveTo(px, marginTop);
    ctx.lineTo(px, marginTop + gridHeight);
  }
  for (let y = 0; y <= project.height; y += 1) {
    const py = marginTop + y * cell + 0.5;
    ctx.moveTo(marginLeft, py);
    ctx.lineTo(marginLeft + gridWidth, py);
  }
  ctx.stroke();

  // 每 10 格加粗
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let x = 0; x <= project.width; x += 10) {
    const px = marginLeft + x * cell + 0.5;
    ctx.moveTo(px, marginTop);
    ctx.lineTo(px, marginTop + gridHeight);
  }
  for (let y = 0; y <= project.height; y += 10) {
    const py = marginTop + y * cell + 0.5;
    ctx.moveTo(marginLeft, py);
    ctx.lineTo(marginLeft + gridWidth, py);
  }
  ctx.stroke();

  // 图例
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#161a20';
  ctx.font = '600 14px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
  ctx.fillText('色号用量', marginLeft, legendTop + 4);
  const columnWidth = gridWidth / legendColumns;
  usage.rows.forEach((row, index) => {
    const column = Math.floor(index / legendRows);
    const rowIndex = index % legendRows;
    const x = marginLeft + column * columnWidth;
    const y = legendTop + 30 + rowIndex * 26;
    ctx.fillStyle = row.color.hex;
    ctx.fillRect(x, y - 8, 16, 16);
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y - 7.5, 15, 15);
    ctx.fillStyle = '#1f2937';
    ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(row.color.code, x + 24, y);
    ctx.fillStyle = '#4b5563';
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(`× ${row.count}`, x + 68, y);
  });

  canvas.toBlob((blob) => {
    if (blob) download(blob, `${safeName(project.name)}-${project.width}x${project.height}.png`);
  }, 'image/png');
}

export function exportUsageCsv(project, usage) {
  const lines = [
    ['项目', project.name || '拼豆图纸'],
    ['尺寸', `${project.width} x ${project.height}`],
    ['品牌', project.brandLabel || project.brand],
    ['总颗数', usage.total],
    ['颜色数', usage.colors],
    [],
    ['色号', '颜色名', '用量', '建议备货(+10%)', '库存', '缺口'],
  ];
  for (const row of usage.rows) {
    lines.push([row.color.code, row.color.name, row.count, row.suggest, row.stock ?? '', row.shortage ?? '']);
  }
  const csv = lines.map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  download(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }), `${safeName(project.name)}-用量.csv`);
}
