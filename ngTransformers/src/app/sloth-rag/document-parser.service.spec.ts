import { TestBed } from '@angular/core/testing';
import { DocumentParserService } from './document-parser.service';

describe('DocumentParserService', () => {
  let parser: DocumentParserService;

  beforeEach(() => {
    parser = TestBed.inject(DocumentParserService);
  });

  it('parses .txt files', async () => {
    const doc = await parser.parse(new File(['hello sloth 🦥'], 'notes.txt'));
    expect(doc.type).toBe('text');
    expect(doc.text).toBe('hello sloth 🦥');
  });

  it('parses .md and .markdown files as raw markdown', async () => {
    for (const name of ['readme.md', 'README.MARKDOWN']) {
      const doc = await parser.parse(new File(['# Title\n\nBody'], name));
      expect(doc.type).toBe('markdown');
      expect(doc.text).toBe('# Title\n\nBody');
    }
  });

  it('rejects unsupported files', async () => {
    await expect(parser.parse(new File(['x'], 'old.doc'))).rejects.toThrow('Unsupported file type: .doc');
  });
});
