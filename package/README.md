# html-to-pdf-headless

A Node.js package to generate **PDFs and DOCX files** from HTML strings **without** headless browsers like Puppeteer. Uses [JSDOM](https://github.com/jsdom/jsdom), [html-to-pdfmake](https://github.com/Aymkdn/html-to-pdfmake), [pdfmake](http://pdfmake.org/), and [docx](https://github.com/dolanmiri/docx) under the hood.

## Installation

```bash
npm install html-to-pdf-headless
```

## Quick Start

```javascript
const htmlToPdf = require("html-to-pdf-headless");
const fs = require("fs");

const html = `
  <h1>Invoice</h1>
  <p><strong>Name:</strong> John Doe</p>
  <table>
    <thead>
      <tr>
        <th>Item</th>
        <th>Qty</th>
        <th>Price</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Product A</td>
        <td>2</td>
        <td>$100</td>
      </tr>
      <tr>
        <td>Product B</td>
        <td>1</td>
        <td>$150</td>
      </tr>
    </tbody>
  </table>
`;

// Optional: custom styles for pdfmake classes
const styles = {
  "html-h1": {
    color: "#003366",
  },
};

htmlToPdf.createPdf(html, styles).getBuffer(function (buffer) {
  fs.writeFileSync("./output.pdf", buffer);
  console.log("PDF created successfully!");
});
```

## API

### `createPdf(html, styles)`

| Parameter | Type     | Description                                                |
| --------- | -------- | ---------------------------------------------------------- |
| `html`    | `String` | The HTML string to convert to PDF                          |
| `styles`  | `Object` | *(Optional)* pdfmake style definitions for CSS class names |

Returns a **pdfmake document** object. Use its methods to get the output:

- `.getBuffer(callback)` — get a `Buffer` (for saving to file or sending as a response)
- `.getBase64(callback)` — get a base64 string
- `.getDataUrl(callback)` — get a data URL

### Example: Save PDF to File

```javascript
htmlToPdf.createPdf(html, styles).getBuffer(function (buffer) {
  fs.writeFileSync("./report.pdf", buffer);
});
```

### Example: Send PDF in Express Response

```javascript
app.get("/pdf", (req, res) => {
  htmlToPdf.createPdf(html).getBuffer(function (buffer) {
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", 'attachment; filename="report.pdf"');
    res.send(Buffer.from(buffer));
  });
});
```

---

### `createDocFile(html)`

| Parameter | Type     | Description                       |
| --------- | -------- | --------------------------------- |
| `html`    | `String` | The HTML string to convert to DOCX |

Returns a **Promise\<Buffer\>** that resolves with the `.docx` file contents.

Uses the same CSS inlining pipeline as `createPdf`, so `<style>` blocks, inline styles, and all supported CSS properties work identically.

#### Supported HTML Elements (DOCX)

| Element                              | Support                              |
| ------------------------------------ | ------------------------------------ |
| Headings (`h1`–`h6`)                | Native Word heading styles           |
| Paragraphs (`p`, `div`)             | Alignment, spacing, shading, borders |
| Bold / Italic (`b`, `i`, `em`)      | Fully supported                      |
| Underline / Strikethrough (`u`, `s`) | Fully supported                      |
| Links (`a`)                         | Hyperlinks with blue underline       |
| Lists (`ul`, `ol`, `li`)            | Bulleted and numbered lists          |
| Tables (`table`, `tr`, `td`, `th`)  | colspan, rowspan, cell shading       |
| Images (`img`)                      | Base64 data URIs only                |
| Preformatted text (`pre`)           | Monospace font, preserved whitespace |
| Blockquotes (`blockquote`)          | Indented with left border            |
| Code (`code`)                       | Monospace with gray background       |
| Line breaks (`br`, `hr`)            | Supported                            |
| `<style>` blocks                    | Auto-inlined (same as PDF)           |

### Example: Save DOCX to File

```javascript
const htmlToPdf = require("html-to-pdf-headless");
const fs = require("fs");

htmlToPdf.createDocFile(html).then(function (buffer) {
  fs.writeFileSync("./report.docx", buffer);
  console.log("DOCX created!");
});
```

### Example: Send DOCX in Express Response

```javascript
app.get("/docx", async (req, res) => {
  const buffer = await htmlToPdf.createDocFile(html);
  res.set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.set("Content-Disposition", 'attachment; filename="report.docx"');
  res.send(buffer);
});
```

### Example: Generate Both PDF and DOCX from Same HTML

```javascript
const htmlToPdf = require("html-to-pdf-headless");
const fs = require("fs");

const html = `<h1>Report</h1><p>Hello <strong>World</strong></p>`;

// PDF
htmlToPdf.createPdf(html).getBuffer(function (buffer) {
  fs.writeFileSync("./report.pdf", buffer);
});

// DOCX
htmlToPdf.createDocFile(html).then(function (buffer) {
  fs.writeFileSync("./report.docx", buffer);
});
```

## Styling

### CSS `<style>` Blocks (Recommended)

The package **automatically inlines CSS from `<style>` blocks** into each element. This means you can use CSS classes, IDs, element selectors, descendant selectors, and `nth-child` selectors:

```html
<style>
  table { width: 100%; }
  th { background-color: #3498db; color: white; padding: 8px; }
  td { border: 1px solid #ddd; padding: 6px; }
  .highlight { background: #fff3cd; font-weight: bold; }
  tr:nth-child(even) { background: #f9f9f9; }
  h1 { color: #2c3e50; text-align: center; }
</style>
```

All matching CSS rules are applied as inline styles before PDF generation. Inline `style=""` attributes on elements always take priority over `<style>` block rules.

### pdfmake Style Overrides

The converter also maps HTML tags to pdfmake style classes like `html-h1`, `html-p`, `html-table`, etc. You can override these via the `styles` parameter:

```javascript
const styles = {
  "html-h1": { fontSize: 28, bold: true, color: "#003366" },
  "html-p": { fontSize: 12, margin: [0, 5, 0, 10] },
  "html-table": { margin: [0, 10, 0, 10] },
  "html-th": { bold: true, fillColor: "#EEEEEE" },
};
```

## Supported HTML Elements

| Element                          | Support                       |
| -------------------------------- | ----------------------------- |
| Headings (`h1`–`h6`)            | Font sizes + bold             |
| Paragraphs (`p`, `div`)         | Margins, alignment            |
| Bold / Italic (`b`, `i`, `em`)  | Fully supported               |
| Links (`a`)                     | Color + underline             |
| Lists (`ul`, `ol`, `li`)        | Numbered and bulleted         |
| Tables (`table`, `tr`, `td`)    | colspan, rowspan              |
| Images (`img`)                  | src attribute (base64 or URL) |
| Line breaks (`br`, `hr`)        | Supported                     |
| Inline styles                   | Most CSS properties mapped    |
| `<style>` blocks                | Auto-inlined to elements      |

## HTML Best Practices for PDF Generation

To get the best results, follow these guidelines:

1. **Use valid HTML structure** — Avoid putting `<p>` directly inside `<tr>`. Always wrap cell content in `<td>` or `<th>`.

   ```html
   <!-- BAD -->
   <tr><p>Text</p></tr>

   <!-- GOOD -->
   <tr><td><p>Text</p></td></tr>
   ```

2. **Don't nest `<tr>` inside `<td>`** — This is invalid HTML and may produce unexpected results.

   ```html
   <!-- BAD -->
   <td><tr><td>Nested</td></tr></td>

   <!-- GOOD: Use a nested table instead -->
   <td><table><tr><td>Nested</td></tr></table></td>
   ```

3. **Use `border` on `<td>`/`<th>` for table borders** — the `border-collapse` CSS property is not supported in pdfmake.

4. **CSS `<style>` blocks work** — CSS rules from `<style>` blocks are automatically inlined. Both inline styles and `<style>` blocks work.

5. **Image sources** — Use base64 data URIs for images. Remote URLs (`http://...`) are replaced with placeholder text since pdfmake in Node.js cannot fetch remote resources.

6. **Table widths** — Set `width: 100%` on your `<table>` element (via inline style or CSS class) to make tables span the full page width.

## Known Limitations

- **CSS `@media` queries** are ignored (not relevant for PDF generation)
- **Unsupported CSS properties** like `display`, `box-sizing`, `border-collapse`, `border-radius`, `box-shadow`, `position`, `float`, `overflow`, and vendor-prefixed properties (`-webkit-*`, `-ms-*`) are automatically filtered out
- **Fonts** — Only Roboto is available by default. All CSS font families (`sans-serif`, `Georgia`, `Arial`, etc.) are mapped to Roboto
- **Remote images** — URLs (`http://...`, `https://...`) cannot be fetched; use base64 data URIs or local file paths instead
- **CSS gradients** — `linear-gradient()` and similar background values are not supported
- **Padding** — CSS `padding` is not supported by pdfmake and is ignored

## License

ISC
