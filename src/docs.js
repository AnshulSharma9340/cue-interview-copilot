// Extracts plain text from uploaded resumes and reference documents.
const fs = require('fs');
const path = require('path');

async function extractText(file) {
  const ext = path.extname(file).toLowerCase();
  const buf = fs.readFileSync(file);
  if (ext === '.pdf') {
    const pdf = require('pdf-parse/lib/pdf-parse.js');
    return (await pdf(buf)).text;
  }
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    return (await mammoth.extractRawText({ buffer: buf })).value;
  }
  return buf.toString('utf8');
}

async function loadDocument(file) {
  const text = (await extractText(file)).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return { name: path.basename(file), size: fs.statSync(file).size, text, addedAt: Date.now() };
}

module.exports = { loadDocument, FILTERS: [{ name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md'] }] };
