'use strict';
/**
 * Minimal dependency-free PDF writer for monospace documents (receipts, tabular reports).
 * Produces valid PDF 1.4 using the built-in Courier font. Not a layout engine — by design:
 * receipts and exported reports are line-oriented.
 */

function esc(s) {
  // PDF string escaping; restrict to Latin-1-ish printable range, replace others.
  return String(s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/₦/g, 'NGN ')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * @param {string[]} lines
 * @param {{pageWidth?:number,pageHeight?:number,fontSize?:number,margin?:number,title?:string,boldLines?:Set<number>}} opts
 */
function textPdf(lines, opts = {}) {
  const fontSize = opts.fontSize || 9;
  const leading = fontSize * 1.25;
  const margin = opts.margin || 36;
  const pageWidth = opts.pageWidth || 595;   // A4
  const pageHeight = opts.pageHeight || 842;
  const perPage = Math.max(1, Math.floor((pageHeight - margin * 2) / leading));
  const pages = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += perPage) pages.push(lines.slice(i, i + perPage));

  const objects = [];
  const add = (s) => { objects.push(s); return objects.length; };
  const catalogId = add(null);
  const pagesId = add(null);
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  const boldId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>');
  const pageIds = [];
  pages.forEach((pageLines, pi) => {
    let content = 'BT\n';
    let y = pageHeight - margin - fontSize;
    pageLines.forEach((ln, li) => {
      const idx = pi * perPage + li;
      const bold = opts.boldLines && opts.boldLines.has(idx);
      content += `/${bold ? 'F2' : 'F1'} ${fontSize} Tf 1 0 0 1 ${margin} ${y.toFixed(2)} Tm (${esc(ln)}) Tj\n`;
      y -= leading;
    });
    content += 'ET';
    const streamId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents ${streamId} 0 R /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldId} 0 R >> >> >>`);
    pageIds.push(pageId);
  });
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const infoId = add(`<< /Title (${esc(opts.title || 'Document')}) /Producer (Meridian POS) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);

  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => { out += `${String(off).padStart(10, '0')} 00000 n \n`; });
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

module.exports = { textPdf };
