import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_ROWS = 250_000;

export type ParsedAccountingFile = {
  headers: string[];
  rows: string[][];
  sheets: string[];
  format: 'CSV' | 'XLSX' | 'PDF';
  textBasedPdf?: boolean;
};

function cellToString(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).trim();
}

export function parseDelimited(text: string): { headers: string[]; rows: string[][] } {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const candidates = [';', ',', '\t', '|'];
  const countDelimiters = (line: string, delimiter: string) => {
    let count = 0;
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === '"' && line[index + 1] === '"' && quoted) index += 1;
      else if (line[index] === '"') quoted = !quoted;
      else if (line[index] === delimiter && !quoted) count += 1;
    }
    return count;
  };
  const delimiter = candidates
    .map((candidate) => ({ candidate, count: countDelimiters(firstLine, candidate) }))
    .sort((left, right) => right.count - left.count)[0]?.candidate || ';';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && quoted && text[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return { headers: rows.shift() || [], rows: rows.slice(0, MAX_ROWS) };
}

type PdfItem = { str: string; transform: number[]; width: number };
type PdfCell = { x: number; text: string };
type PdfLine = { page: number; y: number; cells: PdfCell[]; text: string };

function makePdfLine(items: PdfItem[]): PdfLine {
  const ordered = items
    .filter((item) => item.str.trim())
    .map((item) => ({ x: item.transform[4] || 0, width: item.width || 0, text: item.str.trim() }))
    .sort((left, right) => left.x - right.x);
  const gaps = ordered.slice(1).map((item, index) =>
    Math.max(0, item.x - (ordered[index].x + ordered[index].width)),
  );
  const sortedGaps = [...gaps].sort((left, right) => left - right);
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)] || 0;
  const splitGap = Math.max(12, medianGap * 2.4);
  const cells: PdfCell[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index];
    const current = cells[cells.length - 1];
    const previous = ordered[index - 1];
    const gap = previous ? item.x - (previous.x + previous.width) : 0;
    if (!current || gap > splitGap) cells.push({ x: item.x, text: item.text });
    else current.text = `${current.text} ${item.text}`.trim();
  }
  return { page: 0, y: 0, cells, text: cells.map((cell) => cell.text).join(' ').toLowerCase() };
}

async function readTextPdf(file: File): Promise<ParsedAccountingFile> {
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist');
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const document = await getDocument({ data: await file.arrayBuffer() }).promise;
  const lines: PdfLine[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const items: PdfItem[] = [];
    for (const item of content.items) {
      const candidate = item as unknown as PdfItem;
      if (
        typeof candidate.str === 'string' &&
        Array.isArray(candidate.transform) &&
        typeof candidate.width === 'number'
      ) {
        items.push(candidate);
      }
    }
    const byY = new Map<number, PdfItem[]>();
    for (const item of items) {
      const y = Math.round(item.transform[5] / 3) * 3;
      byY.set(y, [...(byY.get(y) || []), item]);
    }
    for (const [y, rowItems] of byY) {
      const line = makePdfLine(rowItems);
      lines.push({ ...line, page: pageNumber, y });
    }
  }
  lines.sort((left, right) => left.page - right.page || right.y - left.y);

  if (!lines.some((line) => line.cells.length)) {
    throw new Error('PDF_IMAGE_ONLY');
  }
  if (lines.length > MAX_ROWS + document.numPages) {
    throw new Error('FILE_TOO_MANY_ROWS');
  }

  const dateWords = /\bdate\b|date pièce|date piece|تاريخ/;
  const accountWords = /\bcompte\b|account|حساب/;
  const debitWords = /débit|debit|مدين/;
  const creditWords = /crédit|credit|دائن/;
  const header = lines.find((line) =>
    dateWords.test(line.text) &&
    accountWords.test(line.text) &&
    debitWords.test(line.text) &&
    creditWords.test(line.text),
  );

  if (!header || header.cells.length < 3) {
    const longest = Math.max(...lines.map((line) => line.cells.length));
    const columnCount = Math.max(1, Math.min(longest, 32));
    return {
      headers: Array.from({ length: columnCount }, (_, index) => `Colonne ${index + 1}`),
      rows: lines
        .filter((line) => line.cells.length)
        .map((line) => Array.from(
          { length: columnCount },
          (_, index) => line.cells[index]?.text || '',
        ))
        .slice(0, MAX_ROWS),
      sheets: [],
      format: 'PDF',
      textBasedPdf: true,
    };
  }

  const headers = header.cells.map((cell) => cell.text);
  const anchors = header.cells.map((cell) => cell.x);
  const headerKey = header.cells.map((cell) => cell.text).join('|').toLowerCase();
  const rows = lines
    .filter((line) =>
      line !== header &&
      line.cells.length &&
      ![dateWords, accountWords, debitWords, creditWords].every((pattern) => pattern.test(line.text)) &&
      !line.cells.map((cell) => cell.text).join('|').toLowerCase().includes(headerKey),
    )
    .map((line) => {
      const values = Array.from({ length: headers.length }, () => '');
      for (const cell of line.cells) {
        let nearest = 0;
        for (let index = 1; index < anchors.length; index += 1) {
          if (Math.abs(cell.x - anchors[index]) < Math.abs(cell.x - anchors[nearest])) nearest = index;
        }
        values[nearest] = `${values[nearest]} ${cell.text}`.trim();
      }
      return values;
    })
    .filter((row) => row.some(Boolean))
    .slice(0, MAX_ROWS);

  return { headers, rows, sheets: [], format: 'PDF', textBasedPdf: true };
}

export async function readAccountingFile(
  file: File,
  requestedSheet?: string,
): Promise<ParsedAccountingFile> {
  if (file.size > MAX_FILE_BYTES) throw new Error('FILE_TOO_LARGE');
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'csv' || extension === 'txt') {
    const bytes = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(bytes);
    if (text.includes('\uFFFD')) text = new TextDecoder('windows-1252').decode(bytes);
    const parsed = parseDelimited(text.replace(/^\uFEFF/, ''));
    return { ...parsed, sheets: [], format: 'CSV' };
  }
  if (extension === 'xlsx' || extension === 'xls') {
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(await file.arrayBuffer(), {
      type: 'array',
      cellDates: true,
      dense: true,
    });
    const sheets = workbook.SheetNames;
    const sheetName = requestedSheet && sheets.includes(requestedSheet)
      ? requestedSheet
      : sheets[0];
    if (!sheetName) throw new Error('EMPTY_WORKBOOK');
    const values = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    });
    if (values.length > MAX_ROWS + 1) throw new Error('FILE_TOO_MANY_ROWS');
    const rows = values.map((row) => row.map(cellToString));
    return {
      headers: rows.shift() || [],
      rows,
      sheets,
      format: 'XLSX',
    };
  }
  if (extension === 'pdf') return readTextPdf(file);
  throw new Error('UNSUPPORTED_FILE_TYPE');
}
