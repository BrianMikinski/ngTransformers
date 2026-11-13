import { Injectable } from '@angular/core';

export interface ExtractedDocument {
  name: string;
  type: 'pdf' | 'word' | 'excel';
  text: string;
  ms: number;
}

/**
 * Phase 1 of Sloth RAG: turn a dropped file into plain text, entirely in the browser.
 * Each parser is dynamically imported so it only downloads when first needed.
 */
@Injectable({ providedIn: 'root' })
export class DocumentParserService {

  async parse(file: File): Promise<ExtractedDocument> {
    const start = performance.now();
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const data = await file.arrayBuffer();

    let type: ExtractedDocument['type'];
    let text: string;

    if (ext === 'pdf') {
      type = 'pdf';
      text = await this.parsePdf(data);
    } else if (ext === 'docx') {
      type = 'word';
      text = await this.parseDocx(data);
    } else if (['xlsx', 'xls', 'csv'].includes(ext)) {
      type = 'excel';
      text = await this.parseSpreadsheet(data);
    } else {
      throw new Error(`Unsupported file type: .${ext}`);
    }

    return { name: file.name, type, text, ms: Math.round(performance.now() - start) };
  }

  private async parsePdf(data: ArrayBuffer): Promise<string> {
    const pdfjs = await import('pdfjs-dist');
    // Worker file is copied to the build output by angular.json "assets".
    pdfjs.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.mjs';

    const pdf = await pdfjs.getDocument({ data }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const content = await (await pdf.getPage(i)).getTextContent();
      const pageText = content.items.map(item => ('str' in item ? item.str : '')).join(' ');
      pages.push(`--- Page ${i} ---\n${pageText}`);
    }
    return pages.join('\n\n');
  }

  private async parseDocx(arrayBuffer: ArrayBuffer): Promise<string> {
    const mammoth = (await import('mammoth')).default;
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value;
  }

  private async parseSpreadsheet(data: ArrayBuffer): Promise<string> {
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(data, { type: 'array' });
    return workbook.SheetNames
      .map(name => `--- Sheet: ${name} ---\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}`)
      .join('\n\n');
  }
}
